/**
 * The category picker for a Team definition.
 *
 * A native select cannot be styled where it matters: its option list is drawn by
 * the platform, so it ignores the plugin's surface. This draws the trigger and the
 * list itself, borrowing the composer picker's row metrics.
 * @module dsh-agent-team-presets/client/CategorySelect
 */
/** Props of the category picker. */
export interface CategorySelectProps {
    /** Selected category id, or the empty string for "no category". */
    readonly value: string;
    /** Categories in stored order. */
    readonly categories: readonly {
        readonly id: string;
        readonly name: string;
        readonly order?: number;
    }[];
    /** Copy of the empty choice. */
    readonly noneLabel: string;
    readonly disabled: boolean;
    /** Called with the new category id (empty string clears it). */
    readonly onChange: (id: string) => void;
}
/**
 * Render the picker.
 * @param props - the selection, the choices and the write callback.
 * @returns a trigger button and, while open, the option list beneath it.
 */
export declare function CategorySelect(props: CategorySelectProps): React.ReactElement;
