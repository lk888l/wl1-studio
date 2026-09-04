import type { TelemetrySample } from "../types";
import { chartPath } from "../lib/telemetry";

interface LiveChartProps {
  samples: readonly TelemetrySample[];
  compact?: boolean;
}

const WIDTH = 720;
const HEIGHT = 220;

export function LiveChart({ samples, compact = false }: LiveChartProps) {
  const visible = compact ? samples.slice(-90) : samples;
  const pitchPath = chartPath(visible, (sample) => sample.pitch, WIDTH, HEIGHT, 12);
  const rollPath = chartPath(visible, (sample) => sample.roll, WIDTH, HEIGHT, 12);
  const latest = visible.at(-1);
  return (
    <section className="live-chart" aria-label="实时姿态曲线">
      <div className="chart-toolbar">
        <div>
          <span className="section-kicker">LIVE ATTITUDE</span>
          <h3>实时姿态</h3>
        </div>
        <div className="chart-legend">
          <span><i className="legend-dot is-pitch" />俯仰 {latest?.pitch.toFixed(2) ?? "--"}°</span>
          <span><i className="legend-dot is-roll" />横滚 {latest?.roll.toFixed(2) ?? "--"}°</span>
        </div>
      </div>
      <div className="chart-stage">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="最近遥测样本中的俯仰角与横滚角">
          <defs>
            <linearGradient id="pitchStroke" x1="0" x2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity=".35" />
              <stop offset="1" stopColor="var(--accent)" />
            </linearGradient>
            <linearGradient id="rollStroke" x1="0" x2="1">
              <stop offset="0" stopColor="#5fd4c7" stopOpacity=".32" />
              <stop offset="1" stopColor="#21a99a" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3, 4].map((line) => (
            <line className="chart-grid" key={line} x1="0" x2={WIDTH} y1={line * (HEIGHT / 4)} y2={line * (HEIGHT / 4)} />
          ))}
          {[0, 1, 2, 3, 4, 5, 6].map((line) => (
            <line className="chart-grid chart-grid--vertical" key={line} x1={line * (WIDTH / 6)} x2={line * (WIDTH / 6)} y1="0" y2={HEIGHT} />
          ))}
          {pitchPath && <path className="chart-line chart-line--pitch" d={pitchPath} />}
          {rollPath && <path className="chart-line chart-line--roll" d={rollPath} />}
        </svg>
        {visible.length === 0 && <div className="chart-empty">等待新鲜姿态遥测；超过 600 ms 未更新会自动清空显示</div>}
      </div>
      <div className="chart-footer">
        <span>{visible.length} 个样本</span>
        <span>窗口约 {Math.max(1, Math.round(visible.length / 20))} 秒</span>
        <span className="live-indicator"><i /> 20 Hz UI</span>
      </div>
    </section>
  );
}
