// The user's reply to a review screenshot, read by the program from the user's own
// words. The model's stated decision must agree with this, so it cannot approve a
// submission by itself. Submitting is irreversible and asking again is cheap, so
// anything that is not plainly "submit" is left undecided (null) and asked about.

const ABANDON =
  /放弃|算了|不要了|不用了|不开了|不开票了|不提交|别提交|先不|不需要了|不办了|关掉|关闭页面|取消/;
const FIX =
  /不对|不正确|错了|有误|写错|填错|选错|漏了|有问题|修正|修改|改成|改为|改一下|要改|应该是|应为|重新填|重填|换成/;
// "Nothing is wrong" phrases contain fix words ("没有问题", "没填错", "不需要修改");
// they are removed before looking for a correction.
const NOTHING_WRONG =
  /没(?:有|什么)?(?:问题|毛病)|没有?(?:填|写|选)?错|(?:不|无)(?:需要?|用|必)(?:再)?(?:修改|改|重填)|确认无误|无误/g;
// "不提交/先不开" mention submitting only to refuse it.
const REFUSED = /(?:先|暂时?|还是)?(?:不|别|不要|先别)(?:要|用)?(?:提交|开)/g;
// Said alongside an abandon word: "filled correctly, but don't submit".
const CORRECT = /正确|没问题|无误|对的|没错|都对|填对了|填得对/;
// Questions and conditions are not decisions: "提交到哪个邮箱", "如果没问题就提交".
const UNSETTLED =
  /[?？]|吗|么|哪|什么|怎么|是不是|对不对|能不能|可不可以|要不要|有没有|行不行|好不好|如果|假如|要是|的话|等一?下|等等|稍等|再看|看看/;
const NEGATED = /不(?:确认|可以|行|是|好|提交)|别|不要|没有?确认/;
// An explicit instruction to submit. "确认一下邮箱" asks to check something, not to submit.
const SUBMIT_WORD = /提交|开票吧|开吧|确认(?!了?一?下|是否|过)/;
// A whole reply that is only an approval, such as "好的" or "没问题".
const BARE_APPROVAL =
  /^(?:确定|没问题|都没问题|可以|好|好的|行|是|是的|对|对的|没错|都对|ok|okay|yes)+$/i;
const FILLER = /[\s\p{P}\p{S}]|[了吧啊呀哈嗯哦呢]/gu;

export function classifyDecision(text) {
  const value = String(text || '').trim();
  const rest = value.replace(NOTHING_WRONG, '，');
  const abandon = ABANDON.test(value),
    fix = FIX.test(rest);
  const submitWord = SUBMIT_WORD.test(value.replace(REFUSED, '，'));
  if (abandon && !fix && !submitWord) return CORRECT.test(value) ? 'approve' : 'abandon';
  if (fix && !abandon) return 'fix';
  if (abandon || fix || UNSETTLED.test(rest) || NEGATED.test(rest)) return null;
  if (submitWord || BARE_APPROVAL.test(value.replace(FILLER, ''))) return 'submit';
  return null;
}

const GENERIC_FIX =
  /不对|不正确|错了|有误|有问题|修正|修改|要改|改一下|重新填|重填|这张|这个|那个|截图|页面|填写|好像|感觉|有点|还是|全|都|吧|了|啊|呢|呀|的|嗯|哦|请|帮我|一下|[\s\p{P}\p{S}]/gu;
// A correction must say what is wrong; "不对" alone is answered with a question.
export const correctionDetail = (text) => String(text || '').replace(GENERIC_FIX, '').length >= 2;
