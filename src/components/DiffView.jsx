import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { unifiedMergeView } from '@codemirror/merge';
import { buildEditorMetrics, editorThemes } from '../lib/editorTheme';
import { editorTypography, onTypographyChange } from '../lib/typography';
import { onThemeChange, themeName } from '../lib/theme';
import { languageFor } from '../lib/editorLanguage';

// A read-only unified diff: `modified` shown with what changed from
// `original` marked inline. Shared by the Changes pane's diff tabs and the
// Files tab of a PR in Tasks; follows the app appearance and editor
// typography like the editor does.
export default function DiffView({ name = '', original, modified, className = '' }) {
  const [appearance, setAppearance] = useState(themeName);
  useEffect(() => onThemeChange(setAppearance), []);
  const [typography, setTypography] = useState(editorTypography);
  useEffect(() => onTypographyChange(() => setTypography(editorTypography())), []);

  const extensions = useMemo(
    () => [
      buildEditorMetrics(typography),
      unifiedMergeView({ original, mergeControls: false }),
      ...languageFor(name),
    ],
    [typography, original, name]
  );

  return (
    <CodeMirror
      value={modified}
      height="100%"
      theme={editorThemes[appearance]}
      extensions={extensions}
      editable={false}
      className={className}
      basicSetup={{ tabSize: 2 }}
    />
  );
}
