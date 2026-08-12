// Runtime platform detection via UA sniff ("Firefox/" is unique token; §9.2).
import * as chromePlatform from './chrome';
import * as firefoxPlatform from './firefox';

const isChrome = !navigator.userAgent.includes('Firefox/');

const platform = isChrome ? chromePlatform : firefoxPlatform;

export const { storage, sessionStorage, idle, alarms, identity, action, runtime, tabs } = platform;
// Exported for gdrive-picker.ts: Chrome uses extension:// origin, Firefox uses bridge iframe (§7.3).
export { isChrome };
