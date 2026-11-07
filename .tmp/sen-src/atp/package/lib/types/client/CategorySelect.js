import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The category picker for a Team definition.
 *
 * A native select cannot be styled where it matters: its option list is drawn by
 * the platform, so it ignores the plugin's surface. This draws the trigger and the
 * list itself, borrowing the composer picker's row metrics.
 * @module dsh-agent-team-presets/client/CategorySelect
 */
import { useEffect, useRef, useState } from 'react';
import css from './TeamPresetsSection.module.css';
/**
 * Render the picker.
 * @param props - the selection, the choices and the write callback.
 * @returns a trigger button and, while open, the option list beneath it.
 */
export function CategorySelect(props) {
    const [open, setOpen] = useState(false);
    const wrap = useRef(null);
    const ordered = [...props.categories].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
    const current = ordered.find(entry => entry.id === props.value);
    const label = current === undefined ? props.noneLabel : current.name;
    useEffect(() => {
        if (!open)
            return;
        const onDown = (event) => {
            if (wrap.current?.contains(event.target) === true)
                return;
            setOpen(false);
        };
        const onKey = (event) => { if (event.key === 'Escape')
            setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);
    return (_jsxs("div", { className: css.selectWrap, ref: wrap, children: [_jsx("button", { type: "button", className: css.select, disabled: props.disabled, "aria-haspopup": "listbox", "aria-expanded": open, onClick: () => { setOpen(value => !value); }, children: _jsx("span", { className: css.selectValue, children: label }) }), open ? (_jsxs("div", { className: css.selectPop, role: "listbox", children: [_jsx("button", { type: "button", role: "option", "aria-selected": props.value === '', className: `${css.selectOption} ${props.value === '' ? css.selectOptionActive : ''}`, onClick: () => { props.onChange(''); setOpen(false); }, children: props.noneLabel }), ordered.map(entry => (_jsx("button", { type: "button", role: "option", "aria-selected": props.value === entry.id, className: `${css.selectOption} ${props.value === entry.id ? css.selectOptionActive : ''}`, onClick: () => { props.onChange(entry.id); setOpen(false); }, children: entry.name }, entry.id)))] })) : null] }));
}
