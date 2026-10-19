import { digest } from '../core/validation.mjs';
import { profileFields } from './schema.mjs';

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
      stableId: control.stableId || control.id || '',
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
