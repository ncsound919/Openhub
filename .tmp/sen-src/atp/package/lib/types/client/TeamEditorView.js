import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Second Team preset page: one Team's own name, description, captain, and
 * member roster. Choosing the captain or a member opens that agent's page.
 */
import { useEffect, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { CategorySelect } from "./CategorySelect.js";
import css from './TeamPresetsSection.module.css';
/** Model caption of one configured agent slot. */
function agentRoute(agent, providers) {
    if (agent.provider === '' || agent.model === '')
        return '';
    const provider = providers.find(entry => entry.id === agent.provider);
    const model = provider?.models.find(entry => entry.id === agent.model);
    return `${provider?.name ?? agent.provider} · ${model?.name ?? agent.model}`;
}
/**
 * The display-metadata card.
 *
 * Everything it edits is user-facing only: the panel says so, and the fields are
 * written as one `metadata` patch so a Team's fingerprint (and therefore a
 * running task's applied definition) never changes because a label was edited.
 * @param props - the Team and the patch writer.
 * @returns the folded card.
 */
function MetadataPanel(props) {
    const existing = props.team.metadata ?? {};
    const [fields, setFields] = useState({
        summary: existing.summary ?? '',
        tags: (existing.tags ?? []).join(', '),
        useCases: (existing.useCases ?? []).join('\n'),
        quickPrompts: (existing.quickPrompts ?? []).join('\n'),
        notes: existing.notes ?? '',
    });
    useEffect(() => {
        const meta = props.team.metadata ?? {};
        setFields({
            summary: meta.summary ?? '',
            tags: (meta.tags ?? []).join(', '),
            useCases: (meta.useCases ?? []).join('\n'),
            quickPrompts: (meta.quickPrompts ?? []).join('\n'),
            notes: meta.notes ?? '',
        });
    }, [props.team.id, props.team.metadata]);
    const [open, setOpen] = useState(false);
    const commit = (next) => {
        setFields(next);
        props.onPatch({
            metadata: {
                ...next.summary.trim() === '' ? {} : { summary: next.summary.trim() },
                ...next.notes.trim() === '' ? {} : { notes: next.notes.trim() },
                ...next.tags.trim() === '' ? {} : { tags: next.tags.split(',').map(entry => entry.trim()).filter(entry => entry !== '') },
                ...next.useCases.trim() === '' ? {} : { useCases: next.useCases.split('\n').map(entry => entry.trim()).filter(entry => entry !== '') },
                ...next.quickPrompts.trim() === '' ? {} : { quickPrompts: next.quickPrompts.split('\n').map(entry => entry.trim()).filter(entry => entry !== '') },
            },
        });
    };
    return (_jsxs("section", { className: css.card, children: [_jsxs("span", { className: css.cardTitle, children: [props.t('metadataTitle'), " ", _jsx("span", { className: css.hint, children: props.t('metadataOnlyDisplay') })] }), _jsx("p", { className: css.hint, children: props.t('metadataNote') }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => { setOpen(value => !value); }, children: open ? props.t('metadataFold') : props.t('metadataUnfold') }), open ? (_jsxs(_Fragment, { children: [_jsx("label", { className: css.fieldLabel, children: props.t('metadataSummary') }), _jsx("textarea", { className: css.prompt, rows: 2, disabled: props.disabled, value: fields.summary, onChange: (event) => { commit({ ...fields, summary: event.target.value }); } }), _jsx("label", { className: css.fieldLabel, children: props.t('metadataTags') }), _jsx("input", { className: css.textInput, disabled: props.disabled, value: fields.tags, onChange: (event) => { commit({ ...fields, tags: event.target.value }); } }), _jsx("p", { className: css.hint, children: props.t('metadataTagsHint') }), _jsx("label", { className: css.fieldLabel, children: props.t('metadataUseCases') }), _jsx("textarea", { className: css.prompt, rows: 3, disabled: props.disabled, value: fields.useCases, onChange: (event) => { commit({ ...fields, useCases: event.target.value }); } }), _jsx("label", { className: css.fieldLabel, children: props.t('metadataQuickPrompts') }), _jsx("textarea", { className: css.prompt, rows: 3, disabled: props.disabled, value: fields.quickPrompts, onChange: (event) => { commit({ ...fields, quickPrompts: event.target.value }); } }), _jsx("label", { className: css.fieldLabel, children: props.t('metadataNotes') }), _jsx("textarea", { className: css.prompt, rows: 2, disabled: props.disabled, value: fields.notes, onChange: (event) => { commit({ ...fields, notes: event.target.value }); } })] })) : null] }));
}
/**
 * Render one Team's page.
 * @param props - the Team, catalogue, copy, and navigation callbacks.
 * @returns the back row, the Team identity fields, and the roster.
 */
export function TeamEditorView(props) {
    const { team, t, disabled } = props;
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: css.pageHead, children: [_jsxs("button", { type: "button", className: css.crumb, onClick: props.onBack, children: [_jsx("span", { "aria-hidden": true, children: "\u2039" }), " ", t('backToList')] }), _jsx("h2", { className: css.title, children: team.name === '' ? team.id : team.name })] }), _jsxs("section", { className: css.card, children: [_jsxs("div", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('teamName') }), _jsx(Input, { className: css.input ?? '', value: team.name, placeholder: t('teamNamePlaceholder'), disabled: disabled, onChange: (event) => { props.onPatch({ name: event.target.value }); } })] }), _jsxs("div", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('teamDescription') }), _jsx("textarea", { className: css.prompt, rows: 3, value: team.description, disabled: disabled, onChange: (event) => { props.onPatch({ description: event.target.value }); } })] })] }), _jsx("span", { className: css.sectionTitle, children: t('teamSections') }), _jsxs("section", { className: css.card, children: [_jsxs("button", { type: "button", className: css.entryRow, onClick: () => { props.onOpenAgent('captain'); }, children: [_jsx("span", { className: css.dot, style: team.captain.color === '' ? undefined : { background: team.captain.color }, "aria-hidden": true }), _jsxs("span", { className: css.rowText, children: [_jsxs("span", { className: css.rowName, children: [t('roleCaptain'), team.captain.name.trim() === '' ? '' : ` · ${team.captain.name.trim()}`] }), _jsx("span", { className: css.rowMeta, children: t('captainFollowsSession') })] }), _jsx("span", { className: css.chevron, "aria-hidden": true, children: "\u203A" })] }), _jsx("p", { className: css.hint, children: t('captainHint') })] }), _jsxs("section", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardTitle, children: t('members') }), _jsx(Button, { size: "sm", variant: "outline", disabled: disabled, onClick: props.onAddMember, children: t('addMember') })] }), team.members.length === 0 ? _jsx("p", { className: css.hint, children: t('emptyMembers') }) : (_jsx("ul", { className: css.plainRows, children: team.members.map((member, index) => (_jsxs("li", { className: css.entry, children: [_jsxs("button", { type: "button", className: css.entryRow, onClick: () => { props.onOpenAgent(index); }, children: [_jsx("span", { className: css.dot, style: member.color === '' ? undefined : { background: member.color }, "aria-hidden": true }), _jsxs("span", { className: css.rowText, children: [_jsx("span", { className: css.rowName, children: member.name.trim() === '' ? `${t('roleMember')} ${String(index + 1)}` : member.name.trim() }), _jsx("span", { className: css.rowMeta, children: agentRoute(member, props.providers) || t('inheritSession') })] }), _jsx("span", { className: css.chevron, "aria-hidden": true, children: "\u203A" })] }), _jsx(Button, { size: "sm", variant: "ghost", disabled: disabled, onClick: () => { props.onRemoveMember(index); }, children: t('removeMember') })] }, member.id ?? `${team.id}-member-${String(index)}`))) }))] }), props.onSetCategory === undefined ? null : (_jsxs("section", { className: css.card, children: [_jsx("span", { className: css.cardTitle, children: props.t('categoryOf') }), _jsxs("div", { className: css.field, children: [_jsx(CategorySelect, { value: props.categoryId ?? '', categories: props.categories ?? [], noneLabel: props.t('categoryNone'), disabled: props.disabled, onChange: (id) => { props.onSetCategory?.(id); } }), _jsx("span", { className: css.hint, children: props.t('categoryNote') })] })] })), _jsx(MetadataPanel, { team: props.team, disabled: props.disabled, onPatch: props.onPatch, t: props.t })] }));
}
