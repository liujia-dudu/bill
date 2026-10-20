import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, digest, fieldNames } from '../core/validation.mjs';
import {
  classifyPage,
  inspectInvoiceAmounts,
  assertInvoiceAmounts,
  observePage,
} from '../browser/observe.mjs';
import { companyNameKey, pageCompanyCandidate, validPageTaxId } from '../core/tax-id.mjs';
import { inspectFields } from '../browser/fields.mjs';
import { pageContract } from '../rules/contract.mjs';
import { ruleActions } from '../rules/schema.mjs';

const controlSelector =
  'input,textarea,select,button,a,[role=button],[role=option],[role=combobox],.el-select-dropdown__item,ul[role=listbox] li,.invoice-header-suggest > div';
const forbidden =
  /提交|开票|申请|确认|同意|发送|验证码|支付|购买|删除|submit|apply|confirm|agree|send|pay|purchase|delete/i;
const navigation =
  /^(?:下一步|继续填写|下一页|返回|上一步|更多内容(?:\s*[（(]非必填[）)])?|展开(?:更多)?|收起|next|back)$/i;
const normalize = (value) => value.replace(/\s+/g, ' ').trim();
const searchButton =
  /^(?:查询|搜索|查找|查询税号|税号查询|查询企业|企业查询|查询公司|公司查询|search)$/i;

export function redactProfile(value, profile) {
  if (Array.isArray(value)) return value.map((item) => redactProfile(item, profile));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactProfile(item, profile)]),
    );
  if (typeof value !== 'string') return value;
  let redacted = value;
  for (const [key, val] of Object.entries(profile))
    if (Object.hasOwn(fieldNames, key) && typeof val === 'string' && val.length > 1)
      redacted = redacted.replaceAll(val, `[profile.${key}]`);
  return redacted;
}

export class InvoiceBrowserTools {
  constructor({
    page,
    profile,
    directory,
    mode = 'dry_run',
    onProgress = () => {},
    onCheck = () => {},
    onTaxVerified = async () => {},
    check = () => {},
    demo = false,
  }) {
    this.page = page;
    this.profile = profile;
    this.directory = directory;
    this.mode = mode;
    this.onProgress = onProgress;
    this.onCheck = onCheck;
    this.onTaxVerified = onTaxVerified;
    this.companySelection = null;
    this.taxEvidence = null;
    this.check = check;
    this.demo = demo;
    this.refs = new Map();
    this.checks = [];
    this.selections = [];
    this.trace = [];
    this.preparationSteps = [];
    this.attribute = `data-invoice-${randomUUID().slice(0, 8)}`;
    this.stage = 0;
    this.finished = false;
    this.blocked = null;
    this.observation = null;
    this.startOrigin = new URL(page.url()).origin;
    this.initialUrl = page.url();
    this.initialProfile = { ...profile };
  }
  async observe() {
    this.check();
    this.refs.clear();
    const observationId = randomUUID();
    const frames = [];
    const values = Object.fromEntries(
      Object.keys(fieldNames).map((key) => [key, this.profile[key] || '']),
    );
    for (const [frameIndex, frame] of this.page.frames().entries()) {
      if (frameIndex > 10)
        throw new AppError('页面包含过多嵌套区域，需人工检查', 400, 'complex_page');
      const origin = new URL(frame.url() || 'about:blank').origin;
      const trustedFrame =
        origin === this.startOrigin || (origin === 'null' && (this.demo || frame.parentFrame()));
      const controlsBefore = await frame.evaluate(inspectFields, {
        selector: controlSelector,
        attribute: this.attribute,
        frameIndex,
        values,
      });
      const data = await frame.evaluate(() => ({
        title: document.title,
        text: document.body?.innerText?.slice(0, 18000) || '',
      }));
      const controls = controlsBefore.map((control) => {
        const elementRef = `${observationId}:${control.id}`;
        const identity = {
          tag: control.tag,
          type: control.type,
          role: control.role,
          label: control.label,
          context: control.context,
          placeholder: control.placeholder,
          name: control.name,
          stableId: control.stableId,
        };
        const seller = /销售方|销方|商家信息|seller/i.test(`${control.context} ${control.label}`);
        const text = normalize(control.text);
        let actions = [];
        if (control.visible && control.enabled && trustedFrame && !seller) {
          if (
            ['input', 'textarea'].includes(control.tag) &&
            !['radio', 'checkbox', 'submit', 'button', 'file', 'hidden', 'password'].includes(
              control.type,
            ) &&
            control.editable
          )
            actions.push('fill');
          if (control.role === 'combobox') actions.push('open_choices');
          if (control.tag === 'select' || control.type === 'radio') actions.push('select');
          if (control.role === 'option' || control.tag === 'li' || control.companySuggestion)
            actions.push('choose_company');
          if (control.tag === 'button' && control.type === 'button' && searchButton.test(text))
            actions.push('query_company');
          if (
            ['input', 'textarea'].includes(control.tag) &&
            /税号|纳税人识别号|统一社会信用代码/.test(`${control.label} ${control.placeholder}`)
          )
            actions.push('read_tax');
          if (
            control.tag === 'button' &&
            control.type === 'button' &&
            navigation.test(text) &&
            !forbidden.test(text)
          )
            actions.push('local_navigation');
        }
        this.refs.set(elementRef, {
          frame,
          frameIndex,
          selector: `[${this.attribute}="${control.id}"]`,
          control,
          identity,
          actions,
          observationId,
        });
        return {
          ...control,
          id: undefined,
          elementRef,
          actions,
          excludedSeller: seller,
          trustedFrame,
        };
      });
      frames.push({
        frameIndex,
        title: data.title,
        text: data.text,
        controls,
        amounts: await frame.evaluate(inspectInvoiceAmounts),
      });
    }
    this.observation = {
      observationId,
      stage: this.stage,
      profile: {
        type: this.profile.type,
        availableFields: Object.keys(values).filter((key) => values[key]),
        requiredCore:
          this.profile.type === 'enterprise' ? ['title', 'taxId', 'email'] : ['title', 'email'],
      },
      frames,
      completedFields: this.checks.map(({ key, matches, stage }) => ({ key, matches, stage })),
      mode: this.mode,
      submissionAllowed: false,
      companySelection: this.companySelection
        ? { exactMatch: true, needsTaxReadback: !this.taxEvidence }
        : null,
    };
    const pageState = classifyPage({ frames: frames.map((frame) => ({ innerText: frame.text })) });
    if (pageState) this.blocked = { reason: pageState.message, status: pageState.status };
    await this.persist();
    return redactProfile({ ...this.observation, pageState }, this.profile);
  }
  async target(ref, action) {
    this.check();
    if (this.mode !== 'dry_run' || this.finished || this.blocked)
      throw new AppError('当前任务不允许继续填写', 400, 'task_stopped');
    const target = this.refs.get(ref);
    if (!target || !target.actions.includes(action))
      throw new AppError('目标不存在、已过期或该动作被禁止；请重新观察', 400, 'invalid_element');
    const locator = target.frame.locator(target.selector);
    if ((await locator.count()) !== 1 || !(await locator.isVisible()))
      throw new AppError('控件已变化或不可见，请重新观察', 400, 'stale_element');
    const [field] = await target.frame.evaluate(inspectFields, { selector: target.selector });
    const current = Object.fromEntries(
      Object.keys(target.identity).map((key) => [key, field?.[key]]),
    );
    if (JSON.stringify(current) !== JSON.stringify(target.identity))
      throw new AppError('控件语义已变化，请重新观察', 400, 'stale_element');
    if (action === 'local_navigation') {
      const text = normalize((await locator.textContent()) || '');
      if (
        !navigation.test(text) ||
        forbidden.test(text) ||
        (await locator.getAttribute('type')) !== 'button'
      )
        throw new AppError('按钮作用已变化，禁止执行', 400, 'stale_element');
    }
    if (action === 'choose_company')
      target.control.text = normalize((await locator.textContent()) || '');
    if (['choose_company', 'query_company', 'open_choices'].includes(action)) {
      const unsafe = await locator.evaluate((node) => {
        const action = node.closest('button,a,input[type=submit],[role=button]');
        return Boolean(
          action &&
          (action.tagName === 'A' ||
            action.type === 'submit' ||
            /提交|确认|申请|同意|发送|支付|submit|apply|confirm|agree|send|pay/i.test(
              action.textContent || '',
            )),
        );
      });
      if (unsafe) throw new AppError('该控件可能触发提交，已停止');
    }
    return { ...target, locator };
  }
  async fill({ elementRef, valueRef }) {
    if (!Object.hasOwn(fieldNames, valueRef) || !this.profile[valueRef])
      throw new AppError(`没有已保存的 ${valueRef}，请在对话中补充`, 400, 'missing_profile_field');
    const target = await this.target(elementRef, 'fill');
    if (valueRef === 'title') {
      this.companySelection = null;
      this.taxEvidence = null;
    }
    if (this.profile.type === 'personal' && valueRef === 'taxId')
      throw new AppError('个人抬头不允许填写企业税号');
    await this.onProgress(`填写${fieldNames[valueRef]}`);
    await target.locator.fill(this.profile[valueRef]);
    if (valueRef === 'title' && target.control.automaticCompanyQuery) {
      try {
        await target.frame.waitForFunction(
          () =>
            [...document.querySelectorAll('.invoice-header-suggest > div')].some((node) => {
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }),
          null,
          { timeout: 5000 },
        );
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
      }
    }
    // A combobox query is not yet the selected company. Keep it focused so
    // the next observe can discover options; selection is a separate tool.
    if (target.control.role !== 'combobox' && valueRef !== 'title') await target.locator.blur();
    const actual = await target.locator.inputValue();
    const field = {
      key: valueRef,
      label: fieldNames[valueRef],
      expected: this.profile[valueRef],
      actual,
      matches: actual === this.profile[valueRef],
      stage: this.stage,
      selected: target.control.role !== 'combobox',
      elementRef,
      locator: { frame: target.frame.url().split('?')[0], ...target.identity },
    };
    this.checks = this.checks.filter(
      (item) => !(item.key === valueRef && item.stage === this.stage),
    );
    this.checks.push(field);
    this.trace.push({
      kind: 'fill',
      valueRef,
      identity: target.identity,
      stage: this.stage,
      matches: field.matches,
      at: new Date().toISOString(),
    });
    this.onCheck(this.checks);
    await this.persist();
    return {
      filled: field.matches,
      selected: field.selected,
      valueRef,
      actual: field.matches ? `[profile.${valueRef}]` : '[value differs]',
      next: target.control.automaticCompanyQuery
        ? 'Observe company suggestions and choose the exact match before filling email'
        : field.selected
          ? 'Continue or observe'
          : 'Observe and choose the exact company option',
    };
  }
  async select({ elementRef, option }) {
    const target = await this.target(elementRef, 'select');
    const requested = normalize(String(option));
    if (target.control.type === 'radio') {
      const label = target.control.label;
      const desired =
        this.profile.type === 'enterprise'
          ? /企业|公司|单位|enterprise|company/i
          : /个人|personal/i;
      if (!desired.test(label) || (this.profile.type === 'enterprise' && /非企业/.test(label)))
        throw new AppError('购买方类型与已保存资料不一致');
      await target.locator.check();
    } else {
      const choices = target.control.options.filter(
        (item) => !item.disabled && (item.value === requested || item.label === requested),
      );
      if (choices.length !== 1) throw new AppError('下拉选项不唯一或不存在');
      if (/购买方|抬头类型|开票类型|buyer/i.test(target.control.label)) {
        const desired =
          this.profile.type === 'enterprise' ? /企业|company|enterprise/i : /个人|personal/i;
        if (!desired.test(choices[0].label + ' ' + choices[0].value))
          throw new AppError('购买方类型不符');
      }
      await target.locator.selectOption(choices[0].value);
    }
    this.trace.push({
      kind: 'select',
      identity: target.identity,
      option: requested,
      stage: this.stage,
    });
    const selectedValue =
      target.control.type === 'radio'
        ? await target.locator.isChecked()
        : await target.locator.inputValue();
    this.selections = this.selections.filter(
      (item) => JSON.stringify(item.identity) !== JSON.stringify(target.identity),
    );
    this.selections.push({ identity: target.identity, stage: this.stage, value: selectedValue });
    this.refs.clear();
    return this.observe();
  }
  async openChoices({ elementRef }) {
    const target = await this.target(elementRef, 'open_choices');
    const wrapper = target.locator.locator(
      'xpath=ancestor::*[contains(@class,"el-select__wrapper")][1]',
    );
    await ((await wrapper.count()) ? wrapper : target.locator).click();
    await this.page.waitForTimeout(400);
    return this.observe();
  }
  async chooseCompany({ elementRef }) {
    const target = await this.target(elementRef, 'choose_company');
    if (this.profile.type !== 'enterprise') throw new AppError('个人资料无需查询企业');
    const candidate = pageCompanyCandidate(target.control.text);
    if (!candidate || companyNameKey(candidate.title) !== companyNameKey(this.profile.title))
      throw new AppError('企业候选与完整抬头不一致', 400, 'company_not_found');
    if (candidate.taxId && !validPageTaxId(candidate.taxId))
      throw new AppError('页面候选税号格式或校验位不正确', 400, 'invalid_page_tax');
    if (candidate.taxId && this.profile.taxId && candidate.taxId !== this.profile.taxId)
      throw new AppError('页面税号与已保存资料冲突，请人工核对', 400, 'tax_conflict');
    const title = this.checks.find((item) => item.key === 'title' && item.stage === this.stage);
    if (!title?.matches) throw new AppError('请先用完整公司名称在本页查询');
    const exact = [];
    for (const ref of this.refs.values()) {
      if (!ref.actions.includes('choose_company') || ref.frame !== target.frame) continue;
      const locator = ref.frame.locator(ref.selector);
      if (!(await locator.isVisible())) continue;
      const c = pageCompanyCandidate(normalize((await locator.textContent()) || ''));
      if (c && companyNameKey(c.title) === companyNameKey(this.profile.title))
        exact.push({ ...c, ref });
    }
    // An allow-create combobox may add a name-only item beside the actual
    // company result. A known tax ID distinguishes the complete match.
    const taxMatches = this.profile.taxId
      ? exact.filter((c) => c.taxId === this.profile.taxId)
      : [];
    const eligible = taxMatches.length ? taxMatches : exact;
    if (eligible.length !== 1)
      throw new AppError('页面返回多个同名企业，请人工核对', 400, 'ambiguous_company');
    if (eligible[0].ref.selector !== target.selector)
      throw new AppError('请选择完整名称和已有税号均匹配的企业候选', 400, 'company_not_found');
    const previousTaxes = new Map();
    for (const ref of this.refs.values())
      if (ref.actions.includes('read_tax') && ref.frame === target.frame)
        previousTaxes.set(
          JSON.stringify(ref.identity),
          await ref.frame.locator(ref.selector).inputValue(),
        );
    const titleRefs = [...this.refs.values()].filter(
      (ref) =>
        ref.frame === target.frame &&
        Object.entries(ref.identity).every(([key, value]) => title.locator[key] === value),
    );
    if (titleRefs.length !== 1) throw new AppError('无法唯一确认查询用的公司名称输入框');
    await target.locator.click();
    await target.frame.locator(titleRefs[0].selector).blur();
    await this.page.waitForTimeout(300);
    title.selected = true;
    this.companySelection = {
      ...candidate,
      frame: target.frame,
      previousTaxes,
      text: target.control.text,
    };
    this.trace.push({ kind: 'choose_company', stage: this.stage, identity: target.identity });
    this.refs.clear();
    return this.observe();
  }
  async queryCompany({ elementRef }) {
    const target = await this.target(elementRef, 'query_company');
    if (
      !searchButton.test(normalize((await target.locator.textContent()) || '')) ||
      !this.checks.some((c) => c.key === 'title' && c.matches && c.stage === this.stage)
    )
      throw new AppError('请先填写完整公司名，并确认这是查询按钮');
    await target.locator.click();
    await this.page.waitForTimeout(500);
    return this.observe();
  }
  async readTax({ elementRef }) {
    const target = await this.target(elementRef, 'read_tax');
    const selection = this.companySelection;
    if (!selection || selection.frame !== target.frame)
      throw new AppError('必须先选中本页完整名称唯一匹配的企业查询结果');
    if (
      this.checks.some(
        (c) => c.key === 'taxId' && c.stage === this.stage && c.source !== 'invoice_page',
      )
    )
      throw new AppError('税号已由资料手工填入，不能当作页面查询结果保存');
    const taxId = (await target.locator.inputValue()).trim().toUpperCase();
    if (!validPageTaxId(taxId))
      throw new AppError('页面尚未带回有效税号，请重新观察或人工补充', 400, 'invalid_page_tax');
    if (
      (selection.taxId && selection.taxId !== taxId) ||
      (this.profile.taxId && this.profile.taxId !== taxId)
    )
      throw new AppError('候选、页面回读或已有税号不一致，请人工核对', 400, 'tax_conflict');
    if (!selection.taxId && selection.previousTaxes.get(JSON.stringify(target.identity)) === taxId)
      throw new AppError('无法证明税号由本次页面查询带回，不能保存页面残留值');
    const titleCheck = this.checks.find((c) => c.key === 'title' && c.stage === this.stage);
    const titleRefs = [...this.refs.values()].filter(
      (ref) =>
        ref.frame === target.frame &&
        Object.entries(ref.identity).every(([key, value]) => titleCheck?.locator[key] === value),
    );
    if (titleRefs.length !== 1) throw new AppError('无法核对查询后的完整抬头');
    const titleRef = titleRefs[0];
    const selectedTitle = titleRef.control.selection
      ? pageCompanyCandidate(titleRef.control.selection)?.title
      : await titleRef.frame.locator(titleRef.selector).inputValue();
    if (companyNameKey(selectedTitle || '') !== companyNameKey(this.profile.title))
      throw new AppError('查询后抬头发生变化，不能保存税号');
    const source = {
      kind: 'invoice_page',
      page: target.frame.url().split(/[?#]/)[0],
      retrievedAt: new Date().toISOString(),
      candidateText: selection.text,
      title: this.profile.title,
      taxId,
      evidenceFile: 'company-query.json',
      screenshot: 'company-query.png',
    };
    await this.capture('company-query');
    await writeFile(
      path.join(this.directory, source.evidenceFile),
      JSON.stringify(source, null, 2),
    );
    this.check();
    const saved = await this.onTaxVerified({ title: this.profile.title, taxId, source });
    Object.assign(this.profile, saved || { taxId, taxSource: source });
    this.taxEvidence = source;
    this.checks = this.checks.filter((c) => !(c.key === 'taxId' && c.stage === this.stage));
    this.checks.push({
      key: 'taxId',
      label: fieldNames.taxId,
      expected: taxId,
      actual: taxId,
      matches: true,
      stage: this.stage,
      selected: true,
      source: 'invoice_page',
      elementRef,
      locator: { frame: target.frame.url().split('?')[0], ...target.identity },
    });
    this.trace.push({ kind: 'read_page_tax', identity: target.identity, stage: this.stage });
    this.onCheck(this.checks);
    await this.persist();
    return {
      verified: true,
      saved: true,
      source: 'invoice_page',
      valueRef: 'taxId',
      submitted: false,
    };
  }
  async continue({ elementRef }) {
    const target = await this.target(elementRef, 'local_navigation');
    if (/下一|next|继续/i.test(target.control.text)) {
      const observed = await this.observe();
      const unverified = observed.frames
        .flatMap((frame) => frame.controls)
        .filter(
          (control) =>
            control.visible &&
            control.enabled &&
            control.editable &&
            control.required &&
            ['input', 'textarea'].includes(control.tag) &&
            !['radio', 'checkbox', 'hidden'].includes(control.type) &&
            !control.excludedSeller,
        )
        .filter(
          (control) =>
            !this.checks.some(
              (item) =>
                item.stage === this.stage &&
                item.matches &&
                item.selected &&
                item.locator.stableId === control.stableId &&
                item.locator.label === control.label &&
                (control.valueMatches === item.key || control.selection),
            ),
        );
      if (unverified.length)
        throw new AppError(
          '本页还有未核对的必填项：' + unverified.map((c) => c.label || c.placeholder).join('、'),
        );
    }
    await this.capture(`step-${this.stage}`);
    await target.locator.click();
    // The next step may be a new document; let it load like a normal browser would.
    await this.page.waitForTimeout(250);
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    this.trace.push({ kind: 'local_navigation', text: target.control.text, stage: this.stage });
    this.stage++;
    this.refs.clear();
    return this.observe();
  }
  async finish() {
    this.check();
    if (this.finished) return { readyForReview: true, submitted: false };
    await this.observe();
    if (this.blocked) throw new AppError(this.blocked.reason);
    assertInvoiceAmounts({ url: this.page.url(), frames: this.observation.frames });
    const controls = this.observation.frames.flatMap((f) => f.controls);
    const editable = controls.filter(
      (c) =>
        c.visible &&
        c.enabled &&
        ['input', 'select', 'textarea'].includes(c.tag) &&
        !['hidden', 'button', 'submit', 'radio', 'checkbox'].includes(c.type) &&
        !c.excludedSeller,
    );
    const missing = editable.filter((c) => c.required && !c.valuePresent && !c.selection);
    if (missing.length)
      throw new AppError(
        '仍有未填写必填项：' + missing.map((c) => c.label || c.placeholder).join('、'),
      );
    for (const item of this.checks) {
      const matched = [...this.refs.values()].filter(
        (r) =>
          JSON.stringify(r.identity) ===
          JSON.stringify({
            tag: item.locator.tag,
            type: item.locator.type,
            role: item.locator.role,
            label: item.locator.label,
            context: item.locator.context,
            placeholder: item.locator.placeholder,
            name: item.locator.name,
            stableId: item.locator.stableId,
          }),
      );
      if (matched.length === 0 && item.stage !== this.stage) continue;
      if (matched.length !== 1) throw new AppError('已填写字段发生变化，需重新核对');
      const candidate = matched[0];
      const actual =
        item.key === 'title' && candidate.control.role === 'combobox' && candidate.control.selection
          ? candidate.control.selection.split('|')[0].trim()
          : await candidate.frame.locator(candidate.selector).inputValue();
      item.actual = actual;
      item.matches = actual === item.expected;
      if (!item.matches || !item.selected) throw new AppError(`请完成${item.label}选择并回读核对`);
    }
    for (const selection of this.selections) {
      const matches = [...this.refs.values()].filter(
        (ref) => JSON.stringify(ref.identity) === JSON.stringify(selection.identity),
      );
      if (!matches.length && selection.stage !== this.stage) continue;
      if (matches.length !== 1) throw new AppError('已选择选项发生变化，请重新核对');
      const ref = matches[0],
        locator = ref.frame.locator(ref.selector);
      const current =
        ref.control.type === 'radio' ? await locator.isChecked() : await locator.inputValue();
      if (current !== selection.value) throw new AppError('页面改写了已选择的选项，请重新核对');
    }
    const unmapped = editable.filter(
      (c) =>
        c.required &&
        !this.selections.some(
          (item) =>
            JSON.stringify(item.identity) === JSON.stringify(this.refs.get(c.elementRef)?.identity),
        ) &&
        !this.checks.some(
          (item) =>
            item.locator.stableId === c.stableId &&
            item.locator.name === c.name &&
            item.locator.label === c.label &&
            item.matches,
        ),
    );
    if (unmapped.length)
      throw new AppError(
        '仍有未核对的必填项：' + unmapped.map((c) => c.label || c.placeholder).join('、'),
      );
    const core =
      this.profile.type === 'enterprise' ? ['title', 'taxId', 'email'] : ['title', 'email'];
    const incomplete = core.filter(
      (key) => !this.checks.some((item) => item.key === key && item.matches && item.selected),
    );
    if (incomplete.length) throw new AppError('缺少完整购买方字段核对：' + incomplete.join('、'));
    const next = controls.some(
      (c) => c.actions.includes('local_navigation') && /下一|next|继续/i.test(c.text),
    );
    if (next) throw new AppError('还有下一步尚未完成，请继续观察后续必填项');
    const submit = controls.some(
      (c) =>
        c.visible && (c.type === 'submit' || /提交|确认开票|申请开票|submit|apply/i.test(c.text)),
    );
    if (!submit) throw new AppError('尚未确认抵达最终提交前页面，不能完成填写测试');
    await this.capture('pre-submit');
    this.finished = true;
    this.onCheck(this.checks);
    await this.persist();
    return { readyForReview: true, submitted: false, requiresHumanReview: true };
  }
  async capture(name) {
    await this.page.screenshot({
      path: path.join(this.directory, `${name}.png`),
      fullPage: true,
      timeout: 15000,
    });
  }
  async persist() {
    await writeFile(
      path.join(this.directory, 'agent-trace.json'),
      JSON.stringify(
        {
          stage: this.stage,
          trace: this.trace,
          checks: this.checks,
          preparationSteps: this.preparationSteps,
        },
        null,
        2,
      ),
    );
  }
  async dispatch(name, args) {
    this.check();
    if (this.finished && name !== 'invoice_observe' && name !== 'invoice_finish')
      throw new AppError('填写已完成，等待人工审核');
    const action = Object.keys(ruleActions).find((key) => ruleActions[key] === name);
    const target = this.refs.get(args.elementRef);
    const preparationStep =
      action && !this.finished
        ? {
            action,
            contract: pageContract(await observePage(this.page), this.profile),
            ...(target
              ? {
                  target: {
                    frameIndex: target.frameIndex,
                    identity: { ...target.identity },
                    ...(['select', 'query_company', 'continue'].includes(action)
                      ? { text: target.control.text }
                      : {}),
                  },
                }
              : {}),
            ...(args.valueRef ? { valueRef: args.valueRef } : {}),
            ...(args.option ? { option: args.option } : {}),
          }
        : null;
    const result = await this.execute(name, args);
    if (preparationStep) {
      this.preparationSteps.push(preparationStep);
      await this.persist();
    }
    return result;
  }
  async execute(name, args) {
    switch (name) {
      case 'invoice_observe':
        return this.observe();
      case 'invoice_fill':
        return this.fill(args);
      case 'invoice_select':
        return this.select(args);
      case 'invoice_open_choices':
        return this.openChoices(args);
      case 'invoice_choose_company':
        return this.chooseCompany(args);
      case 'invoice_query_company':
        return this.queryCompany(args);
      case 'invoice_read_tax':
        return this.readTax(args);
      case 'invoice_continue':
        return this.continue(args);
      case 'invoice_finish':
        return this.finish();
      case 'invoice_blocked':
        this.blocked = {
          reason: redactProfile(String(args.reason || '需要人工检查'), this.profile),
        };
        return { stopped: true, reason: this.blocked.reason };
      default:
        throw new AppError('禁止调用未注册工具', 403, 'unknown_tool');
    }
  }
  result() {
    if (!this.finished)
      throw new AppError(
        this.blocked?.reason || '模型尚未完成全部字段核对，已保存过程供检查',
        400,
        'agent_blocked',
      );
    return {
      checks: this.checks,
      signature: digest(this.trace.map(({ kind, identity }) => ({ kind, identity }))),
      signatureComplete: false,
      coverageGaps: ['真实提交及平台受理未验证', '模型探索轨迹尚未人工审核为可复用规则'],
      executionSource: 'agent',
    };
  }
}
