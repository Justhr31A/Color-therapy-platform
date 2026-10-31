import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Transformer, Line } from 'react-konva';
import useProtocolStore from './store';
import ObjectRenderer from './ObjectRenderer';
import useCanvasImage from './useCanvasImage';
import { baseURL } from '../api/client';
import { FINGER_GUIDES } from './config/fingerGuides';

// Anchor/rotation config per object type, applied to the shared Transformer.
function transformerConfigFor(object) {
  switch (object.type) {
    case 'hline':
    case 'vline':
    case 'arrow':
    case 'fingerBand':
      return { enabledAnchors: ['middle-left', 'middle-right'], rotateEnabled: true, keepRatio: false };
    case 'rectangle':
      return {
        enabledAnchors: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'],
        rotateEnabled: true,
        keepRatio: false,
      };
    case 'square':
    case 'triangle':
    case 'invertedTriangle':
    case 'text':
      return { enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], rotateEnabled: true, keepRatio: true };
    case 'dot':
      // a dot with a ring is a circular composite: nothing to rotate
      return { enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], rotateEnabled: false, keepRatio: true };
    case 'ring':
      return { enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], rotateEnabled: true, keepRatio: true };
    default:
      return null; // freeline: no transformer, drag-only
  }
}

/**
 * One hand view. There are four of these on screen at once (see HandWorkspace); each is bound to ONE canvas of the
 * protocol and passes its own canvas id to every store action, so a click on any view acts on that view.
 *
 * `maxWidth`/`maxHeight` are the space the workspace gives this view; the stage is scaled to fit inside it.
 * `readOnly` (Preview) makes the whole layer non-interactive.
 */
export default function HandCanvas({ canvas, maxWidth, maxHeight, readOnly = false, showGrid = false }) {
  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const nodesMap = useRef(new Map());
  const [drawing, setDrawing] = useState(null); // { points: [{x,y} normalized] } while drawing a free line

  const activeTool = useProtocolStore((s) => s.activeTool);
  const selectedObjectId = useProtocolStore((s) => s.selectedObjectId);
  const selectObject = useProtocolStore((s) => s.selectObject);
  const focusCanvas = useProtocolStore((s) => s.focusCanvas);
  const addObjectAtPoint = useProtocolStore((s) => s.addObjectAtPoint);
  const addFreeLineAtPoints = useProtocolStore((s) => s.addFreeLineAtPoints);
  const commitObjectChange = useProtocolStore((s) => s.commitObjectChange);
  const deleteObject = useProtocolStore((s) => s.deleteObject);

  const bgImage = useCanvasImage(`${baseURL}${canvas.backgroundUrl}`);

  // Safety net: every normalized (0-1) coordinate is only meaningful relative to the canvas's configured
  // reference width/height. If an asset is swapped without updating those numbers the image would silently
  // stretch; this makes that loud instead of silent.
  useEffect(() => {
    if (!bgImage) return;
    if (bgImage.naturalWidth !== canvas.width || bgImage.naturalHeight !== canvas.height) {
      // eslint-disable-next-line no-console
      console.error(
        `[HandCanvas] Asset/config size mismatch for "${canvas.backgroundLabel}": configured as ${canvas.width}x${canvas.height} ` +
          `but the actual file is ${bgImage.naturalWidth}x${bgImage.naturalHeight}. Object placement will look wrong.`
      );
    }
  }, [bgImage, canvas]);

  const { displayWidth, displayHeight, scale } = useMemo(() => {
    const s = Math.max(0.05, Math.min(maxWidth / canvas.width, maxHeight / canvas.height));
    return { displayWidth: canvas.width * s, displayHeight: canvas.height * s, scale: s };
  }, [canvas.width, canvas.height, maxWidth, maxHeight]);

  const selectedObject = selectedObjectId ? canvas.objects.find((o) => o.id === selectedObjectId) || null : null;
  const transformerConfig = selectedObject && !readOnly ? transformerConfigFor(selectedObject) : null;

  // Keep this view's Transformer attached to the selected node, if the selection belongs to this view.
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const node = selectedObject ? nodesMap.current.get(selectedObject.id) : null;
    tr.nodes(node && transformerConfig ? [node] : []);
    if (tr.getLayer()) tr.getLayer().batchDraw();
  });

  const registerNode = useCallback((id, node) => {
    if (node) nodesMap.current.set(id, node);
    else nodesMap.current.delete(id);
  }, []);

  const relativePointer = () => {
    const pos = stageRef.current.getRelativePointerPosition();
    return { x: pos.x / canvas.width, y: pos.y / canvas.height };
  };
  const isBackgroundTarget = (target, stage) => target === stage || target.name() === 'bg-image';

  const handleMouseDown = (e) => {
    if (readOnly) return;
    focusCanvas(canvas.id); // working on this view makes it the active one (the tool is kept)
    if (activeTool === 'freeline' && isBackgroundTarget(e.target, stageRef.current)) {
      setDrawing({ points: [relativePointer()] });
    }
  };
  const handleMouseMove = () => {
    if (!drawing) return;
    const p = relativePointer();
    setDrawing((d) => ({ points: [...d.points, p] }));
  };
  const handleMouseUp = () => {
    if (!drawing) return;
    if (drawing.points.length >= 2) addFreeLineAtPoints(drawing.points, canvas.id);
    setDrawing(null);
  };
  const handleStageClick = (e) => {
    if (readOnly || !isBackgroundTarget(e.target, stageRef.current)) return; // clicks on shapes are handled by the shape
    if (activeTool === 'select') {
      selectObject(null);
      return;
    }
    if (activeTool === 'freeline' || activeTool === 'eraser') return;
    const p = relativePointer();
    addObjectAtPoint(p.x, p.y, canvas.id);
  };

  const onSelectFor = (object) => () => {
    if (activeTool === 'eraser') deleteObject(object.id, canvas.id);
    else selectObject(object.id, canvas.id);
  };

  const showGuides = !readOnly && (activeTool === 'fingerBand' || (selectedObject && selectedObject.type === 'fingerBand'));
  const guides = showGuides ? FINGER_GUIDES[canvas.viewKey] : null;
  const gridLines = [];
  if (showGrid) {
    for (let i = 1; i < 10; i += 1) {
      gridLines.push({ key: `v${i}`, points: [(canvas.width * i) / 10, 0, (canvas.width * i) / 10, canvas.height] });
      gridLines.push({ key: `h${i}`, points: [0, (canvas.height * i) / 10, canvas.width, (canvas.height * i) / 10] });
    }
  }

  let cursor = 'crosshair';
  if (readOnly || activeTool === 'select') cursor = 'default';
  else if (activeTool === 'eraser') cursor = 'pointer';

  return (
    <Stage
      ref={stageRef}
      width={displayWidth}
      height={displayHeight}
      scaleX={scale}
      scaleY={scale}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleStageClick}
      onTap={handleStageClick}
      style={{ cursor, background: '#fff' }}
    >
      <Layer listening={!readOnly}>
        {bgImage && <KonvaImage name="bg-image" image={bgImage} width={canvas.width} height={canvas.height} listening />}

        {gridLines.map((g) => (
          <Line key={g.key} points={g.points} stroke="rgba(26,115,232,0.22)" strokeWidth={1 / scale} listening={false} />
        ))}

        {guides &&
          Object.entries(guides).map(([finger, g]) => (
            <Line
              key={finger}
              points={[g.base.x * canvas.width, g.base.y * canvas.height, g.tip.x * canvas.width, g.tip.y * canvas.height]}
              stroke="rgba(26,115,232,0.55)"
              strokeWidth={2 / scale}
              dash={[10 / scale, 8 / scale]}
              listening={false}
            />
          ))}

        {canvas.objects.map((object) => (
          <ObjectRenderer
            key={object.id}
            object={object}
            canvas={canvas}
            isSelected={object.id === selectedObjectId}
            onSelect={onSelectFor(object)}
            onChange={(patch) => commitObjectChange(object.id, patch, canvas.id)}
            nodeRef={(node) => registerNode(object.id, node)}
          />
        ))}

        {drawing && (
          <Line
            points={drawing.points.flatMap((p) => [p.x * canvas.width, p.y * canvas.height])}
            stroke="#e5484d"
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
            dash={[8, 4]}
            listening={false}
          />
        )}

        {transformerConfig ? (
          <Transformer
            ref={transformerRef}
            enabledAnchors={transformerConfig.enabledAnchors}
            rotateEnabled={transformerConfig.rotateEnabled}
            keepRatio={transformerConfig.keepRatio}
            borderStroke="#1a73e8"
            anchorStroke="#1a73e8"
            anchorFill="#ffffff"
          />
        ) : (
          <Transformer ref={transformerRef} nodes={[]} />
        )}
      </Layer>
    </Stage>
  );
}
