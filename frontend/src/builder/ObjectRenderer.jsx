import { useRef } from 'react';
import RadialShape from './shapes/RadialShape';
import LinearShape from './shapes/LinearShape';
import FreeLineShape from './shapes/FreeLineShape';
import PolygonShape from './shapes/PolygonShape';
import RectShape from './shapes/RectShape';
import DotRingShape from './shapes/DotRingShape';
import FingerBandShape from './shapes/FingerBandShape';
import TextShape from './shapes/TextShape';
import OutlineUnderlay from './shapes/OutlineUnderlay';
import { hasActiveRing, hasRings, supports, getOutline, outlineActive } from './model/objectModel';

/**
 * Dispatches a protocol object to the right Konva shape component based on
 * its `type`. Every branch shares the same contract: (object, canvas,
 * isSelected, onSelect, onChange, nodeRef) — `onChange` always receives a
 * normalized-coordinate patch, ready to hand straight to the store.
 *
 * An OUTLINE (any shape that has one switched on) is drawn by <OutlineUnderlay> directly beneath the shape. The
 * underlay is hidden while the shape is being dragged or resized — it is repainted from state when the change
 * commits — so it can never visibly lag behind. A dot with rings draws its own outlines inside its group, and an
 * object with no outline renders exactly as it always did (no extra node at all).
 */
export default function ObjectRenderer(props) {
  const { object, canvas, nodeRef } = props;
  const underlayRef = useRef(null);
  const isComposite = object.type === 'dot' && (hasRings(object) || hasActiveRing(object));
  const wantsUnderlay = !isComposite && supports(object.type, 'outline') && outlineActive(getOutline(object));

  // When there is an underlay, also listen on the shape's node so the underlay steps aside during drag/resize.
  const shapeRef = wantsUnderlay
    ? (node) => {
      if (nodeRef) nodeRef(node);
      if (!node || typeof node.on !== 'function') return;
      const setVisible = (v) => { const g = underlayRef.current; if (g && typeof g.visible === 'function') { g.visible(v); if (g.getLayer && g.getLayer()) g.getLayer().batchDraw(); } };
      node.off('.outlineUnderlay');
      node.on('dragstart.outlineUnderlay transformstart.outlineUnderlay', () => setVisible(false));
      node.on('dragend.outlineUnderlay transformend.outlineUnderlay', () => setVisible(true));
    }
    : nodeRef;
  const shapeProps = { ...props, nodeRef: shapeRef };

  let shape;
  switch (object.type) {
    case 'dot':
      // A dot with attached rings (or the older single ring) is ONE composite object, drawn as a single group.
      shape = isComposite ? <DotRingShape {...shapeProps} /> : <RadialShape {...shapeProps} />;
      break;
    case 'ring':
      shape = <RadialShape {...shapeProps} />;
      break;
    case 'fingerBand':
      shape = <FingerBandShape {...shapeProps} />;
      break;
    case 'text':
      shape = <TextShape {...shapeProps} />;
      break;
    case 'hline':
    case 'vline':
    case 'arrow':
      shape = <LinearShape {...shapeProps} />;
      break;
    case 'freeline':
      shape = <FreeLineShape {...shapeProps} />;
      break;
    case 'triangle':
    case 'invertedTriangle':
      shape = <PolygonShape {...shapeProps} />;
      break;
    case 'rectangle':
    case 'square':
      shape = <RectShape {...shapeProps} />;
      break;
    default:
      return null;
  }
  if (!wantsUnderlay) return shape;
  return (
    <>
      <OutlineUnderlay object={object} canvas={canvas} groupRef={underlayRef} />
      {shape}
    </>
  );
}
