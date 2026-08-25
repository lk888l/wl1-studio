export interface Point2D {
  x: number;
  y: number;
}

export interface LegGeometry {
  driveLength: number;
  upperLength: number;
  couplerLength: number;
  wheelLinkLength: number;
  anchorX: number;
  anchorY: number;
  wheelRadius: number;
}

export interface LegPose {
  theta: number;
  anchor: Point2D;
  knee: Point2D;
  pivot: Point2D;
  crank: Point2D;
  wheel: Point2D;
  assemblyMargin: number;
}

export interface TrajectoryPoint extends Point2D {
  theta: number;
}

export interface FirmwareLegTravel {
  minimumTheta: number;
  maximumTheta: number;
  minimumHeight: number;
  maximumHeight: number;
}

export const DEFAULT_LEG_GEOMETRY: LegGeometry = {
  driveLength: 40,
  upperLength: 40,
  couplerLength: 20,
  wheelLinkLength: 50,
  anchorX: 15,
  anchorY: -20,
  wheelRadius: 10,
};

/** Values hard-coded by car_firmware on the upstream main branch. */
export const FIRMWARE_LEG_LIMITS = {
  solverThetaMin: 0,
  solverThetaMax: 80,
  targetHeightMin: 44.5,
  targetHeightMax: 78.5,
  servoAngleMin: 0,
  servoAngleMax: 50,
  servoAngleOffset: 10,
} as const;

const EPSILON = 1e-9;

export function distance(first: Point2D, second: Point2D): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

/**
 * Forward kinematics ported from simulation/Leg_kinematics.py.
 * Coordinates intentionally use positive Y down, matching both the original
 * inverted Matplotlib axis and the SVG coordinate system used by the studio.
 */
export function solveLegKinematics(geometry: LegGeometry, theta: number): LegPose | null {
  if (!Object.values(geometry).every(Number.isFinite) || !Number.isFinite(theta)) return null;
  if (
    geometry.driveLength <= 0
    || geometry.upperLength <= 0
    || geometry.couplerLength <= 0
    || geometry.wheelLinkLength <= 0
    || geometry.wheelRadius <= 0
  ) return null;

  const radians = theta * Math.PI / 180;
  const pivot = { x: 0, y: 0 };
  const anchor = { x: geometry.anchorX, y: geometry.anchorY };
  const crank = {
    x: geometry.driveLength * Math.cos(radians),
    y: geometry.driveLength * Math.sin(radians),
  };

  const dx = crank.x - anchor.x;
  const dy = crank.y - anchor.y;
  const centerDistance = Math.hypot(dx, dy);
  const maximumReach = geometry.upperLength + geometry.couplerLength;
  const minimumReach = Math.abs(geometry.upperLength - geometry.couplerLength);
  if (
    centerDistance <= EPSILON
    || centerDistance > maximumReach + EPSILON
    || centerDistance < minimumReach - EPSILON
  ) return null;

  const projection = (
    geometry.upperLength ** 2
    - geometry.couplerLength ** 2
    + centerDistance ** 2
  ) / (2 * centerDistance);
  const heightSquared = geometry.upperLength ** 2 - projection ** 2;
  if (heightSquared < -EPSILON) return null;

  const intersectionHeight = Math.sqrt(Math.max(0, heightSquared));
  const projected = {
    x: anchor.x + projection * dx / centerDistance,
    y: anchor.y + projection * dy / centerDistance,
  };
  // Keep the same assembly branch (the "positive solution") as the Python simulator.
  const knee = {
    x: projected.x + intersectionHeight * dy / centerDistance,
    y: projected.y - intersectionHeight * dx / centerDistance,
  };
  const extensionRatio = geometry.wheelLinkLength / geometry.couplerLength;
  const wheel = {
    x: crank.x + extensionRatio * (crank.x - knee.x),
    y: crank.y + extensionRatio * (crank.y - knee.y),
  };

  return {
    theta,
    anchor,
    knee,
    pivot,
    crank,
    wheel,
    assemblyMargin: Math.min(maximumReach - centerDistance, centerDistance - minimumReach),
  };
}

export function sampleLegTrajectory(
  geometry: LegGeometry,
  minimumTheta = 0,
  maximumTheta = 120,
  step = 1,
): TrajectoryPoint[] {
  if (!Number.isFinite(step) || step <= 0 || maximumTheta < minimumTheta) return [];
  const points: TrajectoryPoint[] = [];
  for (let theta = minimumTheta; theta <= maximumTheta + EPSILON; theta += step) {
    const pose = solveLegKinematics(geometry, Math.min(theta, maximumTheta));
    if (pose) points.push({ ...pose.wheel, theta: pose.theta });
  }
  const lastTheta = points.at(-1)?.theta;
  if (lastTheta === undefined || maximumTheta - lastTheta > EPSILON) {
    const finalPose = solveLegKinematics(geometry, maximumTheta);
    if (finalPose) points.push({ ...finalPose.wheel, theta: finalPose.theta });
  }
  return points;
}

/** Mirrors LegKinematics::getMotorAngleForHeight, including its 15 iterations. */
export function solveMotorAngleForHeight(geometry: LegGeometry, targetHeight: number): number | null {
  if (!Number.isFinite(targetHeight)) return null;
  let minimum: number = FIRMWARE_LEG_LIMITS.solverThetaMin;
  let maximum: number = FIRMWARE_LEG_LIMITS.solverThetaMax;
  let middle: number = minimum;
  let foundPose = false;

  for (let iteration = 0; iteration < 15; iteration += 1) {
    middle = (minimum + maximum) / 2;
    const pose = solveLegKinematics(geometry, middle);
    if (!pose || pose.wheel.y < 0) {
      maximum = middle;
      continue;
    }
    foundPose = true;
    if (pose.wheel.y < targetHeight) minimum = middle;
    else maximum = middle;
  }
  return foundPose ? middle : null;
}

/**
 * Intersects target-height, inverse-solver, servo-offset and servo-limit
 * constraints so the UI animates only motion the current firmware can realize.
 */
export function firmwareLegTravel(geometry: LegGeometry): FirmwareLegTravel | null {
  const minimumFromHeight = solveMotorAngleForHeight(geometry, FIRMWARE_LEG_LIMITS.targetHeightMin);
  const maximumFromHeight = solveMotorAngleForHeight(geometry, FIRMWARE_LEG_LIMITS.targetHeightMax);
  if (minimumFromHeight === null || maximumFromHeight === null) return null;

  const minimumTheta = Math.max(
    FIRMWARE_LEG_LIMITS.solverThetaMin,
    FIRMWARE_LEG_LIMITS.servoAngleMin + FIRMWARE_LEG_LIMITS.servoAngleOffset,
    minimumFromHeight,
  );
  const maximumTheta = Math.min(
    FIRMWARE_LEG_LIMITS.solverThetaMax,
    FIRMWARE_LEG_LIMITS.servoAngleMax + FIRMWARE_LEG_LIMITS.servoAngleOffset,
    maximumFromHeight,
  );
  if (maximumTheta < minimumTheta) return null;

  const minimumPose = solveLegKinematics(geometry, minimumTheta);
  const maximumPose = solveLegKinematics(geometry, maximumTheta);
  if (!minimumPose || !maximumPose) return null;
  return {
    minimumTheta,
    maximumTheta,
    minimumHeight: minimumPose.wheel.y,
    maximumHeight: maximumPose.wheel.y,
  };
}

export function firmwareServoAngle(theta: number): number {
  const requested = theta - FIRMWARE_LEG_LIMITS.servoAngleOffset;
  return Math.min(FIRMWARE_LEG_LIMITS.servoAngleMax, Math.max(FIRMWARE_LEG_LIMITS.servoAngleMin, requested));
}

export function trajectoryPolyline(points: TrajectoryPoint[]): string {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

export function splitTrajectory(points: TrajectoryPoint[], maximumThetaGap = 1.5): TrajectoryPoint[][] {
  const segments: TrajectoryPoint[][] = [];
  for (const point of points) {
    const current = segments.at(-1);
    const previous = current?.at(-1);
    if (!current || !previous || point.theta - previous.theta > maximumThetaGap) {
      segments.push([point]);
    } else {
      current.push(point);
    }
  }
  return segments;
}
