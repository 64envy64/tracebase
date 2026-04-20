import type { CSSProperties } from "react";
import { CopyCommand } from "@/components/CopyButton";
import styles from "./CtaSection.module.css";

const GRID_COLUMNS = 44;
const GRID_ROWS = 20;

type PixelVariant = "accent" | "muted" | "ghost";
type PixelMotion = "steady" | "glint" | "flicker";

type PixelCell = {
  key: string;
  visible: boolean;
  opacity: number;
  variant: PixelVariant;
  motion: PixelMotion;
  delay: string;
  duration: string;
};

function hash(x: number, y: number, seed: number) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return value - Math.floor(value);
}

function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  return ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2) <= 1;
}

function isBlobCell(x: number, y: number) {
  const leftMass = ellipse(x, y, 0.24, 0.57, 0.22, 0.25);
  const centerMass = ellipse(x, y, 0.47, 0.62, 0.31, 0.19);
  const upperMass = ellipse(x, y, 0.6, 0.42, 0.25, 0.18);
  const nose = ellipse(x, y, 0.77, 0.27, 0.14, 0.08);
  const wing = ellipse(x, y, 0.79, 0.5, 0.17, 0.045);
  const tail = ellipse(x, y, 0.86, 0.66, 0.13, 0.045);
  const carve = ellipse(x, y, 0.76, 0.41, 0.095, 0.115);
  return (leftMass || centerMass || upperMass || nose || wing || tail) && !carve;
}

function createPixels() {
  const mask = Array.from({ length: GRID_ROWS }, (_, row) =>
    Array.from({ length: GRID_COLUMNS }, (_, column) => {
      const x = column / (GRID_COLUMNS - 1);
      const y = row / (GRID_ROWS - 1);
      return isBlobCell(x, y);
    }),
  );

  const cells: PixelCell[] = [];

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const insideBlob = mask[row][column];
      let neighbors = 0;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (mask[row + dy]?.[column + dx]) neighbors += 1;
        }
      }

      const density = neighbors / 8;
      const keepNoise = hash(column, row, 1);
      const threshold = insideBlob
        ? density < 0.45
          ? 0.3
          : density < 0.75
            ? 0.14
            : 0.05
        : 0.95 - density * 0.06;
      const visible = keepNoise >= threshold && (insideBlob || neighbors >= 2);

      const x = column / (GRID_COLUMNS - 1);
      const opacity = Number(
        (
          (insideBlob ? 0.46 : 0.14) +
          density * (insideBlob ? 0.34 : 0.08) +
          hash(column, row, 5) * (insideBlob ? 0.08 : 0.05)
        ).toFixed(2),
      );

      const variantNoise = hash(column, row, 6);
      let variant: PixelVariant = "ghost";
      if (insideBlob && x < 0.26 && variantNoise > 0.22) {
        variant = "accent";
      } else if (insideBlob && variantNoise > 0.68) {
        variant = "accent";
      } else if (insideBlob && variantNoise > 0.28) {
        variant = "muted";
      }

      const motionNoise = hash(column, row, 7);
      const motion: PixelMotion = !insideBlob ? "steady" : density < 0.42 ? "flicker" : motionNoise > 0.54 ? "glint" : "steady";
      const delay = `-${(hash(column, row, 8) * 8.2).toFixed(2)}s`;
      const baseDuration = motion === "flicker" ? 5.2 : motion === "glint" ? 7.8 : 6.8;
      const duration = `${(baseDuration + hash(column, row, 9) * 2.8).toFixed(2)}s`;

      cells.push({
        key: `${column}-${row}`,
        visible,
        opacity,
        variant,
        motion,
        delay,
        duration,
      });
    }
  }

  return cells;
}

const PIXELS = createPixels();

function PixelBlobBackdrop() {
  const style = {
    ["--cta-cols" as string]: GRID_COLUMNS.toString(),
    ["--cta-rows" as string]: GRID_ROWS.toString(),
  } as CSSProperties;

  return (
    <div className={styles.backdrop} style={style} aria-hidden>
      <div className={styles.field}>
        {PIXELS.map((pixel) => {
          const pixelStyle = {
            animationDelay: pixel.delay,
            animationDuration: pixel.duration,
            ["--pixel-opacity" as string]: pixel.opacity.toString(),
          } as CSSProperties;

          return (
            <span
              key={pixel.key}
              className={
                pixel.visible
                  ? `${styles.pixel} ${styles.visible} ${styles[pixel.variant]} ${styles[pixel.motion]}`
                  : `${styles.pixel} ${styles.empty}`
              }
              style={pixelStyle}
            />
          );
        })}
      </div>
    </div>
  );
}

export function CtaSection() {
  return (
    <section className={`${styles.section} py-24 md:py-28`}>
      <PixelBlobBackdrop />

      <div className="relative z-10 max-w-[40rem]">
        <h2 className="max-w-[32rem] text-[clamp(1.9rem,3.2vw,3.15rem)] font-light leading-[1.05] tracking-tight">
          Stop paying for the same reasoning twice.
        </h2>
        <p
          className="mt-4 max-w-[30rem] text-sm font-light leading-relaxed sm:text-[15px]"
          style={{ color: "var(--text-secondary)" }}
        >
          One install. Agents that get better with every run.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <CopyCommand command="npx tracebase-ai setup" />
        </div>
      </div>
    </section>
  );
}
