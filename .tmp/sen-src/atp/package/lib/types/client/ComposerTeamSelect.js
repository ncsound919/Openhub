import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * The composer's Team control: pick the Team preset that leads this Session.
 * It sits in the composer tool row after the permission control.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { selectedTeam } from "../presets.js";
import { TEAM_SERIES } from "../team-catalog.js";
import { matchTeam, orderedCategories, queryTokens, teamOrigin } from "../team-search.js";
import { groupTeams, matchesCategoryFilter } from "./team-grouping.js";
import { FORM_ISSUE_KEYS, selectionFailureText } from "./locales.js";
import css from './ComposerTeamSelect.module.css';
/**
 * Render the composer's Team picker.
 * @param props - the Session identity, the page's locale reader, and the selection writer.
 * @returns the Team trigger, plus a notice when the last selection write failed.
 */
export function ComposerTeamSelect(props) {
    const { t, sessionId } = props;
    const state = props.useTeamPresets(snapshot => snapshot);
    const [open, setOpen] = useState(false);
    const selection = state.selections.find(row => row.sessionId === String(sessionId));
    const active = selectedTeam(state.teams, state.selections, String(sessionId));
    const missing = selection !== undefined && active === undefined;
    const missingLabel = t('composerMissing').replace('{team}', selection?.teamId ?? '');
    // A selection the Host refused is reported here, on the control the user
    // clicked: the trigger's own title carries it and a sibling notice makes it
    // visible without a hover, because the failure this replaces was exactly a
    // click that left no trace anywhere. A document this page cannot use says so
    // in the title too, so a disabled trigger is never a dead end.
    const failure = state.selectionFailure === undefined ? undefined : selectionFailureText(state.selectionFailure, t);
    const issue = state.formIssue === undefined ? undefined : t(FORM_ISSUE_KEYS[state.formIssue]);
    const writable = state.status === 'ready' && state.writable;
    const [query, setQuery] = useState('');
    const [source, setSource] = useState('all');
    const [series, setSeries] = useState('all');
    const [categoryId, setCategoryId] = useState('');
    const popover = useRef(null);
    // Close on Escape or on a press outside, which is what a popover that is not a
    // native menu has to do itself.
    useEffect(() => {
        if (!open)
            return;
        const onKey = (event) => { if (event.key === 'Escape')
            setOpen(false); };
        const onDown = (event) => {
            const node = popover.current;
            if (node !== null && event.target instanceof Node && !node.contains(event.target))
                setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown);
        };
    }, [open]);
    const tokens = queryTokens(query);
    const categories = useMemo(() => orderedCategories(state.categories), [state.categories]);
    // The same taxonomy as the settings list: source, then the series or the
    // reader's own categories, with placement winning over the shipped series.
    const groups = useMemo(() => groupTeams(state.teams.filter((team) => {
        const matchesSource = source === 'all' || teamOrigin(team.id).source === source;
        const matchesCategory = matchesCategoryFilter(team, series, categoryId, state.teamCategories);
        const matchesQuery = tokens.length === 0 || matchTeam(team, tokens) !== undefined;
        return matchesSource && matchesCategory && matchesQuery;
    }), state.categories, state.teamCategories), [state.teams, state.categories, state.teamCategories, source, series, categoryId, tokens]);
    const groupLabel = (group) => {
        if (group.kind === 'series')
            return group.series === 'classic-development' ? t('composeSeriesDev') : t('composeSeriesModes');
        if (group.kind === 'category') {
            return categories.find(entry => entry.id === group.categoryId)?.name ?? group.categoryId ?? '';
        }
        return t('composeUncategorized');
    };
    const choose = (teamId) => {
        setOpen(false);
        void props.selectTeam(String(sessionId), teamId);
    };
    return (_jsxs(_Fragment, { children: [_jsxs("span", { className: css.wrap, ref: popover, children: [_jsxs("button", { type: "button", className: css.trigger, disabled: !writable, "aria-haspopup": "listbox", "aria-expanded": open, title: failure ?? issue ?? (missing ? `${missingLabel}. ${t('composerMissingHint')}` : t('composerHint')), onClick: () => { setOpen(value => !value); }, children: [active === undefined || active.captain.color === ''
                                ? null
                                : (_jsx("span", { className: css.accentDot, style: { background: active.captain.color }, "aria-hidden": true })), _jsx("span", { className: css.triggerLabel, "aria-label": t('composerTitle'), children: missing ? missingLabel : active === undefined ? t('composerNone') : (active.name === '' ? active.id : active.name) }), _jsx("span", { className: css.triggerIcon, children: _jsx(IconChevronDownOutlineRegular, { size: 14 }) })] }), open ? (_jsxs("div", { className: css.popover, role: "listbox", "aria-label": t('composeTitle'), children: [_jsxs("div", { className: css.popHead, children: [_jsx("span", { children: t('composeTitle') }), _jsx("button", { type: "button", className: css.popClose, onClick: () => { setOpen(false); }, children: t('composeClose') })] }), _jsx("input", { className: css.popSearch, autoFocus: true, value: query, placeholder: t('composeSearch'), onChange: (event) => { setQuery(event.target.value); } }), _jsxs("div", { className: css.popChips, children: [_jsx("span", { className: css.popFilterLabel, children: t('filterSource') }), _jsx("button", { type: "button", className: `${css.popChip} ${source === 'all' ? css.popChipActive : ''}`, onClick: () => { setSource('all'); }, children: t('listAll') }), _jsx("button", { type: "button", className: `${css.popChip} ${source === 'builtin' ? css.popChipActive : ''}`, onClick: () => { setSource('builtin'); setCategoryId(''); }, children: t('listBuiltin') }), _jsx("button", { type: "button", className: `${css.popChip} ${source === 'custom' ? css.popChipActive : ''}`, onClick: () => { setSource('custom'); setSeries('all'); }, children: t('listCustom') })] }), _jsxs("div", { className: css.popChips, children: [_jsx("span", { className: css.popFilterLabel, children: t('filterCategory') }), _jsx("button", { type: "button", className: `${css.popChip} ${series === 'all' && categoryId === '' ? css.popChipActive : ''}`, onClick: () => { setSeries('all'); setCategoryId(''); }, children: t('listAll') }), source !== 'custom' ? TEAM_SERIES.map(entry => (_jsx("button", { type: "button", className: `${css.popChip} ${series === entry.id ? css.popChipActive : ''}`, onClick: () => { setSeries(series === entry.id ? 'all' : entry.id); setCategoryId(''); }, children: entry.id === 'classic-development' ? t('seriesDevelopment') : t('seriesWorkModes') }, entry.id))) : null, source !== 'builtin' ? categories.map(entry => (_jsx("button", { type: "button", className: `${css.popChip} ${categoryId === entry.id ? css.popChipActive : ''}`, onClick: () => { setCategoryId(categoryId === entry.id ? '' : entry.id); setSeries('all'); }, children: entry.name }, entry.id))) : null, source === 'custom' && categories.length === 0
                                        ? _jsx("span", { className: css.popFilterLabel, children: t('filterNoCategory') })
                                        : null] }), _jsxs("div", { className: css.popList, children: [_jsxs("button", { type: "button", className: `${css.popOption} ${selection === undefined ? css.popOptionActive : ''}`, onClick: () => { choose(undefined); }, children: [_jsx("span", { className: css.popOptionName, children: t('composerNone') }), _jsx("span", { className: css.popOptionSub, children: t('composeNoneSub') })] }), missing ? (_jsxs("button", { type: "button", className: css.popOption, disabled: true, children: [_jsx("span", { className: css.popOptionName, children: missingLabel }), _jsx("span", { className: css.popOptionSub, children: t('composerMissingHint') })] })) : null, groups.map(group => group.teams.length === 0 ? null : (_jsxs("div", { children: [_jsx("div", { className: css.popGroup, children: groupLabel(group) }), group.teams.map((team) => (_jsxs("button", { type: "button", role: "option", "aria-selected": selection?.teamId === team.id, className: `${css.popOption} ${selection?.teamId === team.id ? css.popOptionActive : ''}`, onClick: () => { choose(team.id); }, children: [_jsx("span", { className: css.popOptionName, children: team.name === '' ? team.id : team.name }), _jsx("span", { className: css.popOptionSub, title: team.description, children: team.description || team.metadata?.summary || '' })] }, team.id)))] }, group.id))), groups.every(group => group.teams.length === 0) ? _jsx("div", { className: css.popEmpty, children: t('composeEmpty') }) : null] })] })) : null] }), failure === undefined ? null : _jsx("span", { className: css.failure, role: "status", children: failure })] }));
}
