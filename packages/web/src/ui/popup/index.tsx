import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
    throw new Error('popup.html is missing #root');
}
createRoot(container).render(<App />);
