import { digest } from '../core/validation.mjs';
import { profileFields } from './schema.mjs';

// Framework-generated ids (Element Plus el-id-1222-11, React :r1:, uuids) change on
// every page load, so they cannot tell the same page apart across visits.
const GENERATED_ID =
  /^(?:el-id-\d+-\d+|:r[0-9a-z]+:|«r[0-9a-z]+»|radix-:r[0-9a-z]+:.*|rc_select_\d+|__BVID__\d+|mui-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const stableId = (id) => (GENERATED_ID.test(id || '') ? '' : id || '');

export function pageContract(observation, profile) {
  const frames = observation.frames.map((frame) => ({
    title: frame.title,
    headings: frame.headings || [],
    agreements: frame.agreements || [],
    selectedOptions: frame.selectedOptions || [],
    controls: frame.controls.map((control) => ({
      tag: control.tag,
      type: control.type,
      role: control.role,
      label: control.label,
      context: control.context,
      placeholder: control.placeholder,
      name: control.name,
      stableId: stableId(control.stableId || control.id),
      required: control.required,
      disabled: control.disabled ?? !control.enabled,
      visible: control.visible,
      editable: control.editable,
      checked: control.checked,
      options: control.options || [],
      text: ['button', 'select'].includes(control.tag) ? control.text : '',
    })),
  }));
  return digest({ type: profile.type, profileFields: profileFields(profile), frames });
}
