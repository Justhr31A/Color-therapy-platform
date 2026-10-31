import { useEffect, useState } from 'react';

/**
 * Loads an image by URL for use as a Konva <Image>. Works for any raster
 * format (png/jpg) and for SVG too — the browser rasterizes an <img>-loaded
 * SVG the same way, so the organ/body asset registry can start serving SVG
 * diagrams later with no change here.
 */
export default function useCanvasImage(url) {
  const [image, setImage] = useState(null);

  useEffect(() => {
    if (!url) {
      setImage(null);
      return undefined;
    }
    let cancelled = false;
    const img = new window.Image();
    // Deliberately no crossOrigin attribute: Phase 1 never reads canvas pixel
    // data back out, so we don't need (or want to risk failing on) strict
    // CORS headers just to display the background image.
    img.onload = () => {
      if (!cancelled) setImage(img);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);

  return image;
}
