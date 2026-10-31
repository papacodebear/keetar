// Self-contained mock of the popup; all data is invented and nothing is stored or sent.
const byId = (id) => document.getElementById(id);
const DEMO_USER = 'sam@shop.example';
const DEMO_PASSWORD = 'not-a-real-password';
const CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*-_=+';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let toastTimer;
let typingTimer;

function toast(message) {
    clearTimeout(toastTimer);
    byId('demo-toast').textContent = message;
    toastTimer = setTimeout(() => (byId('demo-toast').textContent = ''), 1800);
}

function randomInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const value = new Uint32Array(1);
    do {
        crypto.getRandomValues(value);
    } while (value[0] >= limit);
    return value[0] % max;
}

function generate() {
    const length = Number(byId('demo-length').value);
    byId('demo-length-value').textContent = String(length);
    byId('demo-generated').textContent = Array.from({ length }, () => CHARS[randomInt(CHARS.length)]).join('');
}

function newCode() {
    byId('demo-code').textContent = String(randomInt(1000000)).padStart(6, '0');
}

function tickCode() {
    const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
    byId('demo-seconds').textContent = `${remaining}s`;
    if (remaining === 30) {
        newCode();
    }
}

function fill() {
    clearTimeout(typingTimer);
    const user = byId('demo-user');
    const pass = byId('demo-pass');
    pass.value = '';
    if (reducedMotion) {
        user.value = DEMO_USER;
        pass.value = '•'.repeat(DEMO_PASSWORD.length);
    } else {
        user.value = '';
        typeNext(user, pass, 0);
    }
    byId('demo-status').textContent = 'Filled. On a real site, you would now sign in.';
}

function typeNext(user, pass, position) {
    if (position < DEMO_USER.length) {
        user.value += DEMO_USER[position];
    } else if (position < DEMO_USER.length + DEMO_PASSWORD.length) {
        pass.value += '•';
    } else {
        return;
    }
    typingTimer = setTimeout(() => typeNext(user, pass, position + 1), 22);
}

byId('demo-fill').addEventListener('click', fill);
byId('demo-copy-user').addEventListener('click', () => toast('Username copied (demo only)'));
byId('demo-copy-pass').addEventListener('click', () => toast('Password copied (demo only)'));
byId('demo-generate').addEventListener('click', generate);
byId('demo-length').addEventListener('input', generate);
generate();
newCode();
tickCode();
setInterval(tickCode, 1000);
