import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEG_GEOMETRY,
  distance,
  firmwareLegTravel,
  firmwareServoAngle,
  sampleLegTrajectory,
  solveLegKinematics,
  solveMotorAngleForHeight,
  trajectoryPolyline,
} from "./leg-kinematics";

describe("腿部运动学", () => {
  it("保持原 Python 模型的各杆长度约束", () => {
    const pose = solveLegKinematics(DEFAULT_LEG_GEOMETRY, 45);
    expect(pose).not.toBeNull();
    if (!pose) return;

    expect(distance(pose.pivot, pose.crank)).toBeCloseTo(40, 8);
    expect(distance(pose.anchor, pose.knee)).toBeCloseTo(40, 8);
    expect(distance(pose.knee, pose.crank)).toBeCloseTo(20, 8);
    expect(distance(pose.crank, pose.wheel)).toBeCloseTo(50, 8);
    expect(pose.wheel.x).toBeCloseTo(0.4285, 3);
    expect(pose.wheel.y).toBeCloseTo(69.8060, 3);
  });

  it("不可装配的几何参数返回空解", () => {
    const geometry = { ...DEFAULT_LEG_GEOMETRY, anchorX: 200 };
    expect(solveLegKinematics(geometry, 45)).toBeNull();
  });

  it("生成可直接绘制且不含非法值的轮心轨迹", () => {
    const points = sampleLegTrajectory(DEFAULT_LEG_GEOMETRY, 0, 120, 2);
    const polyline = trajectoryPolyline(points);
    // The original 0..120° slider intentionally includes an unreachable tail.
    expect(points).toHaveLength(41);
    expect(polyline).not.toContain("NaN");
    expect(polyline.split(" ")).toHaveLength(41);
  });

  it("复现固件的腿高逆解与三层限幅", () => {
    expect(solveMotorAngleForHeight(DEFAULT_LEG_GEOMETRY, 44.5)).toBeCloseTo(11.189, 3);
    expect(solveMotorAngleForHeight(DEFAULT_LEG_GEOMETRY, 78.5)).toBeCloseTo(60.408, 3);

    const travel = firmwareLegTravel(DEFAULT_LEG_GEOMETRY);
    expect(travel).not.toBeNull();
    if (!travel) return;
    expect(travel.minimumTheta).toBeCloseTo(11.189, 3);
    expect(travel.maximumTheta).toBe(60);
    expect(travel.minimumHeight).toBeCloseTo(44.5, 2);
    expect(travel.maximumHeight).toBeCloseTo(78.293, 3);
    expect(firmwareServoAngle(travel.minimumTheta)).toBeCloseTo(1.189, 3);
    expect(firmwareServoAngle(80)).toBe(50);
  });
});
