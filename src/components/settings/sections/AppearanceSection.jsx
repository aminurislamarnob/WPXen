import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { php } from '@codemirror/lang-php';
import { Card, SectionLabel, SettingsRow, Toggle } from '../../ui';
import { NumberSetting, RangeSetting, SelectSetting, TextSetting } from '../controls';
import { useSettings } from '../../../lib/useSettings';
import { useSettingsContext } from '../SettingsLayout';
import { buildEditorMetrics, editorThemes } from '../../../lib/editorTheme';
import { MONO_STACK, onThemeChange, themeName } from '../../../lib/theme';

// Fonts worth offering by name. WPHerd can't enumerate installed families from
// the renderer without the (Chromium-only, permission-gated) local font access
// API, so — like Superset — this is a curated list plus a free-typed fallback:
// anything the user types is used if the OS resolves it, and silently falls
// back to the built-in stack if not.
const NERD_FONTS = [
  'JetBrainsMono Nerd Font',
  'MesloLGS NF',
  'FiraCode Nerd Font',
  'Hack Nerd Font',
  'CaskaydiaCove Nerd Font',
];

const MONO_FONTS = [
  'JetBrains Mono',
  'Fira Code',
  'SF Mono',
  'Menlo',
  'Monaco',
  'IBM Plex Mono',
  'Iosevka',
  'Geist Mono',
  'Source Code Pro',
  'Cascadia Code',
  'Roboto Mono',
  'Ubuntu Mono',
];

const FONT_OPTIONS = [
  { value: '', label: 'Default (JetBrains Mono → system)' },
  ...MONO_FONTS.map((f) => ({ value: f, label: f })),
  ...NERD_FONTS.map((f) => ({ value: f, label: `${f} (Nerd Font)` })),
];

// Each block previews the language that surface actually shows: WP-CLI at a
// prompt for the terminal, a WordPress shortcode class for the editor. Both
// samples are picked to exercise the glyphs a mono font is judged on — =>, !==,
// ->, $ and braces — so ligatures and weight have something to act on.
const SAMPLES = {
  terminal: `$ wp plugin list --status=active
=> 0 !== $count && $x >= 1;`,
  editor: `<?php
final class WPHerd_Hello {
    public function __construct() {
        add_shortcode( 'wpherd_hello', [ $this, 'render' ] );
    }

    public function render( array $atts ): string {
        $a = shortcode_atts( [ 'name' => 'world' ], $atts );
        return $a['name'] !== '' ? esc_html( "Hi {$a['name']}" ) : '';
    }
}`,
};

// Turns the live control values into the shape editorTypography() produces, so
// buildEditorMetrics can consume them unchanged.
function asTypography({ family, size, lineHeight, letterSpacing, weight, ligatures }) {
  return {
    fontFamily: family ? `"${family}", ${MONO_STACK}` : MONO_STACK,
    fontSize: `${size}px`,
    lineHeight: String(lineHeight),
    letterSpacing: letterSpacing ? `${letterSpacing}px` : 'normal',
    fontWeight: String(weight),
    fontVariantLigatures: ligatures ? 'normal' : 'none',
  };
}

// The editor sample is a real read-only CodeMirror running the real PHP grammar
// and the real editor theme, so the preview is the file editor rather than an
// approximation of it — same tag→ANSI colours, same metrics, and it flips with
// the macOS appearance the same way.
function EditorPreview({ sample, ...values }) {
  const [theme, setTheme] = useState(themeName);
  useEffect(() => onThemeChange(setTheme), []);

  const { family, size, lineHeight, letterSpacing, weight, ligatures } = values;
  const extensions = useMemo(
    () => [
      php(),
      buildEditorMetrics(
        asTypography({ family, size, lineHeight, letterSpacing, weight, ligatures })
      ),
      EditorView.lineWrapping,
    ],
    [family, size, lineHeight, letterSpacing, weight, ligatures]
  );

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border/60">
      <CodeMirror
        value={sample}
        theme={editorThemes[theme]}
        extensions={extensions}
        editable={false}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          autocompletion: false,
          searchKeymap: false,
        }}
      />
    </div>
  );
}

// The terminal sample stays plain text on the terminal's own surface — it is a
// shell transcript, not a document, so an editor chrome would misrepresent it.
function TerminalPreview({ sample, ...values }) {
  const t = asTypography(values);
  return (
    <div className="sheet-well mt-2 overflow-x-auto px-3 py-2.5">
      <pre className="text-foreground" style={{ ...t, margin: 0 }}>
        {sample}
      </pre>
    </div>
  );
}

// One typography block (terminal or editor). `prefix` is the settings
// namespace; `extras` renders the terminal-only rows.
//
// `preview` holds the value of a slider currently being dragged so the sample
// below tracks the drag without a write per step; it is dropped the moment the
// value is committed.
function TypographyBlock({ label, prefix, visible, extras }) {
  const { settings, setSetting } = useSettings();
  const [preview, setPreview] = useState({});
  const Preview = prefix === 'editor' ? EditorPreview : TerminalPreview;
  const key = (name) => `appearance.${prefix}.${name}`;
  const get = (name, fallback) => preview[name] ?? settings[key(name)] ?? fallback;

  const commit = (name, value) => {
    setPreview(({ [name]: _dropped, ...rest }) => rest);
    setSetting(key(name), value);
  };

  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <Card>
        <SettingsRow id={key('fontFamily')} visible={visible} title="Font family">
          <SelectSetting
            value={get('fontFamily', '')}
            onChange={(v) => setSetting(key('fontFamily'), v)}
            ariaLabel={`${label} font family`}
            options={FONT_OPTIONS}
            className="!w-56"
          />
        </SettingsRow>

        <SettingsRow
          id={key('fontFamily')}
          visible={visible}
          title="Custom font"
          subtitle="Any installed family; falls back to the default stack if missing"
        >
          <TextSetting
            value={get('fontFamily', '')}
            onCommit={(v) => setSetting(key('fontFamily'), v)}
            ariaLabel={`${label} custom font family`}
            className="font-mono !text-xs !w-56"
            placeholder="e.g. Berkeley Mono"
          />
        </SettingsRow>

        <SettingsRow id={key('fontSize')} visible={visible} title="Font size">
          <div className="flex items-center gap-1.5">
            <NumberSetting
              value={get('fontSize', 13)}
              onCommit={(v) => setSetting(key('fontSize'), v)}
              min={8}
              max={32}
              ariaLabel={`${label} font size`}
              className="!w-20 text-center"
            />
            <span className="text-xs text-muted-foreground">px</span>
          </div>
        </SettingsRow>

        <SettingsRow id={key('lineHeight')} visible={visible} title="Line height">
          <RangeSetting
            value={get('lineHeight', prefix === 'editor' ? 1.5 : 1)}
            onPreview={(v) => setPreview((p) => ({ ...p, lineHeight: v }))}
            onCommit={(v) => commit('lineHeight', v)}
            min={0.8}
            max={3}
            step={0.05}
            ariaLabel={`${label} line height`}
            format={(v) => Number(v).toFixed(2)}
          />
        </SettingsRow>

        <SettingsRow id={key('letterSpacing')} visible={visible} title="Letter spacing">
          <RangeSetting
            value={get('letterSpacing', 0)}
            onPreview={(v) => setPreview((p) => ({ ...p, letterSpacing: v }))}
            onCommit={(v) => commit('letterSpacing', v)}
            min={-2}
            max={5}
            step={0.1}
            ariaLabel={`${label} letter spacing`}
            format={(v) => Number(v).toFixed(1)}
          />
        </SettingsRow>

        <SettingsRow id={key('fontWeight')} visible={visible} title="Font weight">
          <SelectSetting
            value={String(get('fontWeight', 400))}
            onChange={(v) => setSetting(key('fontWeight'), Number(v))}
            ariaLabel={`${label} font weight`}
            options={[300, 400, 500, 600, 700].map((w) => ({
              value: String(w),
              label: String(w),
            }))}
          />
        </SettingsRow>

        {/* Editor only. xterm renders through canvas/WebGL, and its ligature
            addon needs Node filesystem access to parse font files — which this
            renderer deliberately doesn't have (contextIsolation, no
            nodeIntegration). A terminal toggle here could only ever be a no-op. */}
        {prefix === 'editor' && (
          <SettingsRow
            id={key('ligatures')}
            visible={visible}
            title="Ligatures"
            subtitle="Render =>, !== and friends as single glyphs (font permitting)"
          >
            <Toggle
              checked={!!get('ligatures', false)}
              onChange={(v) => setSetting(key('ligatures'), v)}
              label={`${label} ligatures`}
            />
          </SettingsRow>
        )}

        {extras}
      </Card>

      <Preview
        sample={SAMPLES[prefix]}
        family={get('fontFamily', '')}
        size={get('fontSize', 13)}
        lineHeight={get('lineHeight', prefix === 'editor' ? 1.5 : 1)}
        letterSpacing={get('letterSpacing', 0)}
        weight={get('fontWeight', 400)}
        ligatures={!!get('ligatures', false)}
      />
    </div>
  );
}

export default function AppearanceSection() {
  const { settings, setSetting } = useSettings();
  const { visible } = useSettingsContext();

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Theme</SectionLabel>
        <Card>
          <SettingsRow
            id="appearance.themeMode"
            visible={visible}
            title="Appearance"
            subtitle="System follows the macOS light/dark setting"
          >
            <SelectSetting
              value={settings['appearance.themeMode']}
              onChange={(v) => setSetting('appearance.themeMode', v)}
              ariaLabel="Appearance"
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </SettingsRow>
        </Card>
      </div>

      <TypographyBlock
        label="Terminal Typography"
        prefix="terminal"
        visible={visible}
        extras={
          <>
            <SettingsRow
              id="appearance.terminal.minimumContrast"
              visible={visible}
              title="Minimum contrast"
              subtitle="Force legibility when a program picks a low-contrast colour (1 = off)"
            >
              <RangeSetting
                value={settings['appearance.terminal.minimumContrast'] ?? 1}
                onCommit={(v) => setSetting('appearance.terminal.minimumContrast', v)}
                min={1}
                max={21}
                step={0.5}
                ariaLabel="Terminal minimum contrast"
                format={(v) => Number(v).toFixed(1)}
              />
            </SettingsRow>

            <SettingsRow
              id="appearance.terminal.cursorStyle"
              visible={visible}
              title="Cursor style"
            >
              <SelectSetting
                value={settings['appearance.terminal.cursorStyle']}
                onChange={(v) => setSetting('appearance.terminal.cursorStyle', v)}
                ariaLabel="Terminal cursor style"
                options={[
                  { value: 'block', label: 'Block' },
                  { value: 'bar', label: 'Bar' },
                  { value: 'underline', label: 'Underline' },
                ]}
              />
            </SettingsRow>

            <SettingsRow
              id="appearance.terminal.cursorBlink"
              visible={visible}
              title="Blink the cursor"
            >
              <Toggle
                checked={settings['appearance.terminal.cursorBlink'] !== false}
                onChange={(v) => setSetting('appearance.terminal.cursorBlink', v)}
                label="Blink the cursor"
              />
            </SettingsRow>
          </>
        }
      />

      <TypographyBlock label="Editor Typography" prefix="editor" visible={visible} />
    </div>
  );
}
