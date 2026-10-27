import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";

import { createGlassMap, GLASS_PRESETS, isWindowsChromium } from "../lib/liquid-glass";
import type { GlassStrength } from "../lib/liquid-glass";

type GlassMode = "fallback" | "refractive" | "opaque";
const GlassContext = createContext({ mode: "fallback" as GlassMode, strength: "balanced" as GlassStrength, reducedMotion: true });

/** Keep platform and accessibility decisions shared by every glass surface. */
export function LiquidGlassProvider({ strength, reducedMotion, children }: {
  strength: GlassStrength;
  reducedMotion: boolean;
  children: ReactNode;
}) {
  const [system, setSystem] = useState({ mode: "fallback" as GlassMode, reducedMotion: true });
  useEffect(() => {
    // SVG reference filters on backdrops are implemented by Windows Chromium /
    // WebView2. Other WebViews retain their existing material and layout.
    if (!isWindowsChromium(navigator.userAgent) || !CSS.supports("backdrop-filter", 'url("#glass")')) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const transparency = matchMedia("(prefers-reduced-transparency: reduce)");
    const contrast = matchMedia("(forced-colors: active)");
    const update = () => setSystem({
      mode: transparency.matches || contrast.matches ? "opaque" : "refractive",
      reducedMotion: motion.matches,
    });
    const preferences = [motion, transparency, contrast];
    update();
    for (const preference of preferences) preference.addEventListener("change", update);
    return () => {
      for (const preference of preferences) preference.removeEventListener("change", update);
    };
  }, []);
  return <GlassContext.Provider value={{ ...system, strength, reducedMotion: reducedMotion || system.reducedMotion }}>{children}</GlassContext.Provider>;
}

type GlassTag = "div" | "header" | "aside" | "section" | "dialog" | "article" | "form" | "button";
type GlassVariant = "surface" | "panel";
type LiquidGlassProps<Tag extends GlassTag> = ComponentPropsWithoutRef<Tag> & {
  as?: Tag;
  variant?: GlassVariant;
  ref?: Ref<HTMLElementTagNameMap[Tag]>;
};
type Lens = { image: string; width: number; height: number };
type GlassStyle = CSSProperties & { "--liquid-filter"?: string };

/** Refract only the live application backdrop; children stay sharp and interactive. */
export function LiquidGlass<Tag extends GlassTag = "div">({ as, ref, variant = "surface", className = "", style, children, ...attributes }: LiquidGlassProps<Tag>) {
  const { mode, strength, reducedMotion } = useContext(GlassContext);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [lens, setLens] = useState<Lens | null>(null);
  const [inView, setInView] = useState(false);
  const lensGeometry = useRef("");
  const generation = useRef(0);
  const filterId = `liquid-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const material = GLASS_PRESETS[strength];
  // Content panels need gentler edges and one displacement pass, especially
  // when several siblings share a workspace. Elevated surfaces retain RGB refraction.
  const preset = variant === "panel" ? {
    blur: Math.min(material.blur, 8),
    refraction: material.refraction * 0.6,
    dispersion: 0,
    bezel: Math.min(material.bezel, 14),
  } : material;
  const attach = useCallback((node: HTMLElement | null) => {
    setElement(node);
    if (typeof ref === "function") ref(node as HTMLElementTagNameMap[Tag] | null);
    else if (ref) ref.current = node as HTMLElementTagNameMap[Tag] | null;
  }, [ref]);

  useEffect(() => {
    if (!element || mode !== "refractive") return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), {
      rootMargin: "160px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, mode]);

  useEffect(() => {
    if (!element || mode !== "refractive" || !inView) return;
    let frame = 0;
    let disposed = false;
    const clearLens = () => {
      lensGeometry.current = "";
      setLens(null);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Layout dimensions exclude page-entry transforms and match SVG units.
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
        const geometry = `${width}:${height}:${radius}:${preset.bezel}`;
        // Returning to a cached size must also invalidate a pending resize decode.
        const current = ++generation.current;
        if (geometry === lensGeometry.current) return;
        const map = createGlassMap(width, height, radius, preset.bezel);
        if (!map) { clearLens(); return; }
        try {
          const canvas = document.createElement("canvas");
          canvas.width = map.width;
          canvas.height = map.height;
          const context = canvas.getContext("2d");
          if (!context) { clearLens(); return; }
          const pixels = context.createImageData(map.width, map.height);
          pixels.data.set(map.pixels);
          context.putImageData(pixels, 0, 0);
          const image = canvas.toDataURL();
          // Decode before swapping filters to avoid an uninitialized map flash.
          const decoded = new Image();
          decoded.src = image;
          void decoded.decode().then(() => {
            if (!disposed && generation.current === current) {
              lensGeometry.current = geometry;
              setLens({ image, width, height });
            }
          }).catch(() => { if (!disposed && generation.current === current) clearLens(); });
        } catch {
          clearLens();
        }
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); };
  }, [element, mode, inView, preset.bezel]);

  useEffect(() => {
    if (!element || mode !== "refractive" || !inView || reducedMotion || variant === "panel") return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = element.getBoundingClientRect();
        const x = Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100));
        const y = Math.max(0, Math.min(100, (event.clientY - bounds.top) / bounds.height * 100));
        element.style.setProperty("--liquid-light-x", `${x}%`);
        element.style.setProperty("--liquid-light-y", `${y}%`);
      });
    };
    const reset = () => {
      cancelAnimationFrame(frame);
      element.style.removeProperty("--liquid-light-x");
      element.style.removeProperty("--liquid-light-y");
    };
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerleave", reset);
    return () => { reset(); element.removeEventListener("pointermove", move); element.removeEventListener("pointerleave", reset); };
  }, [element, mode, inView, reducedMotion, variant]);

  const active = mode === "refractive" && inView && lens !== null;
  const glassStyle: GlassStyle = { ...style, "--liquid-filter": active ? `url("#${filterId}")` : undefined };
  return <>
    {createElement(as ?? "div", {
      ...attributes,
      ref: attach,
      className: `${className} liquid-glass`.trim(),
      style: glassStyle,
      "data-liquid-glass": mode === "opaque" ? "opaque" : active ? "refractive" : "fallback",
      "data-liquid-supported": mode === "fallback" ? undefined : "true",
      "data-liquid-strength": strength,
      "data-liquid-variant": variant,
    }, children)}
    {active && createPortal(
      <svg className="liquid-glass-defs" aria-hidden="true" focusable="false" width="0" height="0">
        <defs>
          <filter id={filterId} x="0" y="0" width={lens.width} height={lens.height} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation={preset.blur} edgeMode="duplicate" result="frost" />
            <feImage href={lens.image} x="0" y="0" width={lens.width} height={lens.height} preserveAspectRatio="none" result="lens" />
            {variant === "panel" ? (
              <feDisplacementMap in="frost" in2="lens" scale={2 * preset.refraction} xChannelSelector="R" yChannelSelector="G" />
            ) : <>
            <feDisplacementMap in="frost" in2="lens" scale={2 * (preset.refraction + preset.dispersion)} xChannelSelector="R" yChannelSelector="G" result="red-shift" />
            <feColorMatrix in="red-shift" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
            <feDisplacementMap in="frost" in2="lens" scale={2 * preset.refraction} xChannelSelector="R" yChannelSelector="G" result="green-shift" />
            <feColorMatrix in="green-shift" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
            <feDisplacementMap in="frost" in2="lens" scale={2 * (preset.refraction - preset.dispersion)} xChannelSelector="R" yChannelSelector="G" result="blue-shift" />
            <feColorMatrix in="blue-shift" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
            <feComposite in="red" in2="green" operator="arithmetic" k2="1" k3="1" result="red-green" />
            <feComposite in="red-green" in2="blue" operator="arithmetic" k2="1" k3="1" />
            </>}
          </filter>
        </defs>
      </svg>, document.body,
    )}
  </>;
}
