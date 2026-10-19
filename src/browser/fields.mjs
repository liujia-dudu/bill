// Runs inside the browser for both initial observations and Agent rechecks.
export function inspectFields({ selector, attribute, frameIndex = 0, values = {} }) {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse'
    );
  };
  const textOf = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() || '';
  const visibleText = (node) => {
    if (!node) return '';
    const clone = node.cloneNode(true);
    const originals = [node, ...node.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    for (let i = 0; i < originals.length; i++) {
      const style = getComputedStyle(originals[i]);
      if (
        originals[i].hidden ||
        originals[i].getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      )
        copies[i].textContent = '';
    }
    return textOf(clone);
  };
  return [...document.querySelectorAll(selector)].slice(0, 160).map((node, index) => {
    const id = `${frameIndex}-${index}`;
    if (attribute) node.setAttribute(attribute, id);
    const row =
      node.closest('.formItem,.el-form-item,.form-field,.field,[data-field],.van-cell') ||
      node.parentElement;
    const group = node.closest('fieldset,section,[role=group],form,.sub-card');
    const labelNode = row?.querySelector('label,.van-field__label,.van-cell__title');
    const label =
      [...(node.labels || [])].map(visibleText).join(' ') ||
      visibleText(labelNode) ||
      node.getAttribute('aria-label') ||
      '';
    const context = visibleText(group?.querySelector('legend,h1,h2,h3,h4,[role=heading]'));
    const value = typeof node.value === 'string' ? node.value : '';
    const rect = node.getBoundingClientRect();
    const markers = [...(row?.querySelectorAll('.require') || [])].filter(
      (marker) => visible(marker) && marker.getAttribute('aria-hidden') !== 'true',
    );
    return {
      id,
      index,
      tag: node.tagName.toLowerCase(),
      type: node.type || '',
      role: node.getAttribute('role') || '',
      label,
      context,
      placeholder: node.getAttribute('placeholder') || '',
      name: node.name || '',
      stableId: node.id || '',
      text: textOf(node).slice(0, 240),
      visible: visible(node),
      enabled: !node.disabled,
      editable: !node.readOnly && !node.disabled,
      required: Boolean(
        node.required ||
        node.getAttribute('aria-required') === 'true' ||
        markers.length ||
        /[*＊]/.test(label),
      ),
      checked: node.checked === true,
      valuePresent: Boolean(value),
      valueMatches: Object.keys(values).find((key) => values[key] && values[key] === value) || null,
      options:
        node.tagName === 'SELECT'
          ? [...node.options].map((option) => ({
              value: option.value,
              label: option.label,
              disabled: option.disabled,
            }))
          : [],
      rect: { width: rect.width, height: rect.height },
      // The committed value may be visually hidden while a combobox is focused.
      selection: textOf(row?.querySelector('.el-select__selected-item:not(.is-hidden)')),
      isContentEditable: node.isContentEditable,
      companySuggestion: node.matches('.invoice-header-suggest > div'),
      automaticCompanyQuery:
        Boolean(node.closest('.invoice-header-content')) && node.tagName === 'INPUT',
    };
  });
}
