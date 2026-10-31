import { useCallback, useEffect, useRef } from 'react';
import { Text } from 'react-konva';
import { getText, round4 } from '../model/objectModel';

/**
 * Renders a Text annotation centred on (x, y). `width` holds the FONT SIZE as a fraction of the canvas width so
 * text scales with the same size presets as everything else. Text is drawn on the canvas as plain text, never
 * interpreted as markup.
 */
export default function TextShape({ object, canvas, onSelect, onChange, nodeRef }) {
  const localRef = useRef(null);
  const fontSizePx = Math.max(6, (object.width || 0.03) * canvas.width);
  const content = getText(object) || ' ';

  const setRefs = useCallback(
    (node) => {
      localRef.current = node;
      if (typeof nodeRef === 'function') nodeRef(node);
    },
    [nodeRef]
  );

  // Centre the text on (x, y) once its size is known.
  useEffect(() => {
    const node = localRef.current;
    if (!node) return;
    node.offsetX(node.width() / 2);
    node.offsetY(node.height() / 2);
    if (node.getLayer()) node.getLayer().batchDraw();
  }, [content, fontSizePx]);

  return (
    <Text
      ref={setRefs}
      x={object.x * canvas.width}
      y={object.y * canvas.height}
      text={content}
      fontSize={fontSizePx}
      fontStyle="bold"
      fill={object.color}
      align="center"
      rotation={object.rotation || 0}
      opacity={object.opacity}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => {
        onChange({ x: e.target.x() / canvas.width, y: e.target.y() / canvas.height });
      }}
      onTransformEnd={(e) => {
        const node = e.target;
        const factor = (node.scaleX() + node.scaleY()) / 2;
        node.scaleX(1);
        node.scaleY(1);
        onChange({
          x: node.x() / canvas.width,
          y: node.y() / canvas.height,
          width: round4((fontSizePx * factor) / canvas.width),
          rotation: node.rotation(),
        });
      }}
    />
  );
}
