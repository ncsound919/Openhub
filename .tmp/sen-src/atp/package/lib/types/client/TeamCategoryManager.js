import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * The Team preset categories page.
 *
 * Categories are local view fields: they never leave this browser document and are
 * never exported with a preset. They live on their own page because renaming or
 * reordering them is occasional housekeeping, not something the list page should
 * crowd beside its filters.
 * @module dsh-agent-team-presets/client/TeamCategoryManager
 */
import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './TeamPresetsSection.module.css';
/**
 * Render the categories page.
 * @param props - the categories, their memberships, copy and write callbacks.
 * @returns the page header, the add field and one row per category.
 */
export function TeamCategoryManager(props) {
    const { t } = props;
    const [draft, setDraft] = useState('');
    const [renaming, setRenaming] = useState('');
    const [renameText, setRenameText] = useState('');
    const ordered = [...props.categories].sort((left, right) => left.order - right.order);
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: css.pageHead, children: [_jsxs("button", { type: "button", className: css.crumb, onClick: props.onBack, children: ["\u2039 ", t('title')] }), _jsx("h2", { className: css.title, children: t('categoryTitle') }), _jsx("p", { className: css.intro, children: t('categorySub') })] }), _jsxs("div", { className: css.addRow, children: [_jsx("input", { className: css.textInput, value: draft, placeholder: t('categoryName'), disabled: props.disabled, onChange: (event) => { setDraft(event.target.value); }, onKeyDown: (event) => {
                            if (event.key !== 'Enter')
                                return;
                            props.onAdd(draft);
                            setDraft('');
                        } }), _jsx(Button, { size: "sm", variant: "outline", disabled: props.disabled, onClick: () => { props.onAdd(draft); setDraft(''); }, children: t('categoryAdd') })] }), ordered.length === 0
                ? _jsx("p", { className: css.empty, children: t('categoryEmpty') })
                : (_jsx("ul", { className: css.plainRows, children: ordered.map((entry, index) => {
                        const count = props.teamCategories.filter(row => row.categoryId === entry.id).length;
                        return (_jsxs("li", { className: css.card, children: [_jsx("span", { className: css.rowMain, children: renaming === entry.id ? (_jsx("input", { className: css.textInput, autoFocus: true, value: renameText, onChange: (event) => { setRenameText(event.target.value); }, onKeyDown: (event) => {
                                            if (event.key === 'Escape')
                                                setRenaming('');
                                            if (event.key !== 'Enter')
                                                return;
                                            props.onRename(entry.id, renameText);
                                            setRenaming('');
                                        } })) : (_jsxs("span", { className: css.rowText, children: [_jsx("span", { className: css.rowName, children: entry.name }), _jsxs("span", { className: css.rowMeta, children: [String(count), " \u00B7 ", t('categoryTeams')] })] })) }), _jsxs("span", { className: css.rowActions, children: [renaming === entry.id
                                            ? (_jsx(Button, { size: "sm", variant: "ghost", onClick: () => { props.onRename(entry.id, renameText); setRenaming(''); }, children: t('categorySave') }))
                                            : (_jsx(Button, { size: "sm", variant: "ghost", disabled: props.disabled, onClick: () => { setRenaming(entry.id); setRenameText(entry.name); }, children: t('categoryRename') })), _jsx(Button, { size: "sm", variant: "ghost", disabled: props.disabled || index === 0, onClick: () => { props.onMove(entry.id, -1); }, children: t('categoryUp') }), _jsx(Button, { size: "sm", variant: "ghost", disabled: props.disabled || index === ordered.length - 1, onClick: () => { props.onMove(entry.id, 1); }, children: t('categoryDown') }), _jsx(Button, { size: "sm", variant: "ghost", disabled: props.disabled, onClick: () => { props.onRemove(entry.id); }, children: t('categoryRemove') })] })] }, entry.id));
                    }) })), _jsx("p", { className: css.hint, children: t('categoryNote') })] }));
}
