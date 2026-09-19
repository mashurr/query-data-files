// Context menus drawn in the webview, closed by Escape, a click elsewhere or scrolling.

import { h } from './dom';

export interface MenuItem {
    label: string;
    run(): void;
    disabled?: boolean;
}

let open: HTMLElement | undefined;
let openedAt = 0;
// Focusing the menu can briefly blur the webview's window; that blur shouldn't close it
const BLUR_GRACE_MS = 250;

export function closeMenu() {
    open?.remove();
    open = undefined;
}

export function showMenu(x: number, y: number, items: (MenuItem | 'separator')[]) {
    closeMenu();
    const menu = h('div', { className: 'menu', role: 'menu' });
    for (const item of items) {
        if (item === 'separator') {
            menu.append(h('div', { className: 'separator', role: 'separator' }));
            continue;
        }
        const button = h('button', { role: 'menuitem', disabled: item.disabled ?? false, text: item.label });
        button.addEventListener('click', () => { closeMenu(); item.run(); });
        menu.append(button);
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
    open = menu;
    openedAt = performance.now();
    (menu.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.focus();
    menu.addEventListener('keydown', e => {
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') { buttons[(i + 1) % buttons.length]?.focus(); e.preventDefault(); }
        if (e.key === 'ArrowUp') { buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); e.preventDefault(); }
    });
}

window.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenu(); } });
window.addEventListener('mousedown', e => { if (open && !open.contains(e.target as Node)) { closeMenu(); } }, true);
window.addEventListener('blur', () => { if (performance.now() - openedAt > BLUR_GRACE_MS) { closeMenu(); } });
