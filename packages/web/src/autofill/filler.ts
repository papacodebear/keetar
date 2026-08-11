// Use native setter + dispatch events for React/Vue/Angular change detection.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
)?.set;

export function fillField(field: HTMLInputElement, value: string): void {
    if (nativeInputValueSetter) {
        nativeInputValueSetter.call(field, value);
    } else {
        field.value = value;
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
}
