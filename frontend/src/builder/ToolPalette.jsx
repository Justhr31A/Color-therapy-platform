import useProtocolStore from './store';
import { TOOL_IDS } from './model/objectModel';

const TOOLS = {
  select: { icon: '↖', label: 'Select' },
  dot: { icon: '●', label: 'Dot' },
  ring: { icon: '◯', label: 'Ring' },
  dotRing: { icon: '◉', label: 'Dot + Ring' },
  fingerBand: { icon: '⌒', label: 'Finger Band' },
  hline: { icon: '―', label: 'H Line' },
  vline: { icon: '│', label: 'V Line' },
  freeline: { icon: '✎', label: 'Free Line' },
  invertedTriangle: { icon: '▽', label: 'Inv. Triangle' },
  triangle: { icon: '△', label: 'Triangle' },
  rectangle: { icon: '▭', label: 'Rectangle' },
  square: { icon: '□', label: 'Square' },
  arrow: { icon: '➜', label: 'Arrow' },
  text: { icon: 'T', label: 'Text' },
  eraser: { icon: '⌫', label: 'Eraser' },
};

/** The 15 authoring tools. A Finger Band needs finger guides, so it is only offered for hand protocols. */
export default function ToolPalette() {
  const activeTool = useProtocolStore((s) => s.activeTool);
  const setActiveTool = useProtocolStore((s) => s.setActiveTool);
  const protocolType = useProtocolStore((s) => (s.protocol ? s.protocol.protocolType : null));

  return (
    <nav className="tool-palette" aria-label="Tools">
      {TOOL_IDS.map((id) => {
        const tool = TOOLS[id];
        const disabled = id === 'fingerBand' && protocolType !== 'hand';
        return (
          <button
            key={id}
            type="button"
            className={`tool-tile ${activeTool === id ? 'active' : ''}`}
            aria-pressed={activeTool === id}
            disabled={disabled}
            title={disabled ? `${tool.label} is only available on hand protocols` : tool.label}
            onClick={() => setActiveTool(id)}
          >
            <span className="tool-icon" aria-hidden="true">{tool.icon}</span>
            <span className="tool-name">{tool.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
