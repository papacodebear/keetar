import { createRoot } from 'react-dom/client';
import { installArgon2 } from '../../background/argon2-wasm';
import { App } from './App';

// Separate bundle requires own Argon2 setup for vault creation and biometric verification (§10.1).
installArgon2();

const container = document.getElementById('root');
if (!container) {
    throw new Error('options.html is missing #root');
}
createRoot(container).render(<App />);
