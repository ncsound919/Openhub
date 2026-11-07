/**
 * The Team preset categories page.
 *
 * Categories are local view fields: they never leave this browser document and are
 * never exported with a preset. They live on their own page because renaming or
 * reordering them is occasional housekeeping, not something the list page should
 * crowd beside its filters.
 * @module dsh-agent-team-presets/client/TeamCategoryManager
 */
import type { TeamPresetsLocaleKey } from './locales.ts';
/** Props of the categories page. */
export interface TeamCategoryManagerProps {
    /** Categories in stored order. */
    readonly categories: readonly {
        readonly id: string;
        readonly name: string;
        readonly order: number;
    }[];
    /** Which Team belongs to which category. */
    readonly teamCategories: readonly {
        readonly teamId: string;
        readonly categoryId: string;
    }[];
    /** Whether the Host document accepts writes. */
    readonly disabled: boolean;
    /** Page copy reader. */
    readonly t: (key: TeamPresetsLocaleKey) => string;
    readonly onBack: () => void;
    readonly onAdd: (name: string) => void;
    readonly onRename: (id: string, name: string) => void;
    readonly onMove: (id: string, delta: -1 | 1) => void;
    readonly onRemove: (id: string) => void;
}
/**
 * Render the categories page.
 * @param props - the categories, their memberships, copy and write callbacks.
 * @returns the page header, the add field and one row per category.
 */
export declare function TeamCategoryManager(props: TeamCategoryManagerProps): React.ReactElement;
