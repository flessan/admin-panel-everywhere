import { normalizeSchema, readForm } from './schema.js';

/** Safe, typed controls. Field names are data keys, never generated DOM IDs. */
export function createSchemaForm(document, schema, data) {
  const element = document.createElement('fieldset');
  element.className = 'schema-form';
  const controls = new Map();
  normalizeSchema(schema).fields.forEach((field, index) => {
    const wrapper = document.createElement('div'); wrapper.className = 'schema-field';
    const label = document.createElement('label'); label.htmlFor = `record-field-${index}`;
    label.textContent = `${field.name} · ${field.type}${field.required ? ' *' : ''}`;
    const input = document.createElement(['json', 'file'].includes(field.type) ? 'textarea' : field.type === 'select' ? 'select' : 'input');
    input.id = label.htmlFor; input.dataset.field = field.name;
    const present = Object.hasOwn(data, field.name);
    if (field.type === 'boolean') { input.type = 'checkbox'; input.checked = data[field.name] === true; }
    else if (field.type === 'select') {
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose a value'; input.append(blank);
      for (const value of field.options) {
        const option = document.createElement('option'); option.value = value; option.textContent = value; input.append(option);
      }
      input.value = present ? data[field.name] : '';
    } else if (['json', 'file'].includes(field.type)) {
      input.value = present ? JSON.stringify(data[field.name], null, 2) : 'null'; input.rows = 4;
    } else {
      input.type = field.type === 'number' ? 'number' : 'text';
      if (field.type === 'number') input.step = 'any';
      input.value = present ? String(data[field.name]) : '';
      if (field.type === 'datetime') input.placeholder = 'ISO 8601, including timezone';
    }
    const include = document.createElement('input'); include.type = 'checkbox';
    include.checked = field.required || present; include.disabled = field.required;
    include.setAttribute('aria-label', `Include ${field.name}`);
    input.disabled = !include.checked;
    include.addEventListener('change', () => { input.disabled = !include.checked; });
    const presence = document.createElement('label'); presence.className = 'include-field';
    presence.append(include, document.createTextNode(' Include field'));
    wrapper.append(label, presence, input);
    if (field.type === 'file') {
      const hint = document.createElement('small');
      hint.textContent = 'Existing file reference as JSON (string/object). No upload or assumed file-reference format.';
      wrapper.append(hint);
    }
    if (field.type === 'datetime') {
      const hint = document.createElement('small'); hint.textContent = 'Timezone is explicit; values are not converted to your browser timezone.'; wrapper.append(hint);
    }
    controls.set(field.name, { input, include, field }); element.append(wrapper);
  });
  return { element, read() {
    const entries = new Map([...controls].map(([name, { input, include, field }]) => [name, {
      included: include.checked, value: field.type === 'boolean' ? input.checked : input.value,
    }]));
    return readForm(schema, entries, data);
  } };
}
