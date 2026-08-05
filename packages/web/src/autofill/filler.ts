// Credential injection compatible with React/Vue/Angular (§5.3). Plain
// `field.value = x` doesn't trigger their change detection — frameworks
// listen through the native setter, which a direct property assignment
// bypasses. Going through the native setter explicitly, then dispatching the
// events those frameworks actually listen for, works everywhere.

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
