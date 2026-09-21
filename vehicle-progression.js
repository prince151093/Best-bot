// Vehicle Life progression curve.
// These are cumulative requirements: a player must meet BOTH VC hours and
// message count for the next vehicle. The anchor values mirror the designed
// progression curve; intermediate vehicles are smoothly interpolated.

const ANCHORS = [
  [1, 0.5, 20],
  [2, 1, 50],
  [3, 2, 150],
  [4, 4, 400],
  [5, 7.2, 721],
  [6, 9.2, 921],
  [10, 17, 1697],
  [20, 42, 4234],
  [50, 218.5, 21854],
  [75, 576, 57627],
  [100, 1294, 129435],
  [114, 1945, 194467],
  [115, 2000, 200000]
];

function interpolate(a, b, id, fieldIndex) {
  const [x1, y1] = [a[0], a[fieldIndex]];
  const [x2, y2] = [b[0], b[fieldIndex]];
  if (x1 === x2) return y2;
  const t = (id - x1) / (x2 - x1);
  // Geometric interpolation gives a progressively harder curve rather than
  // turning the middle of the game into a straight linear ramp.
  return Math.exp(Math.log(y1) + t * (Math.log(y2) - Math.log(y1)));
}

function getVehicleRequirement(vehicleId, totalVehicles = 115) {
  const max = Math.max(1, Math.floor(Number(totalVehicles) || 115));
  const id = Math.max(1, Math.min(Math.floor(Number(vehicleId) || 1), max));

  if (id >= 115 && max >= 115) return { hours: 2000, messages: 200000 };

  // For a shortened list, scale the final anchor to the available count while
  // keeping the early curve intact. The shipped bot has 115 vehicles.
  const anchors = max === 115
    ? ANCHORS
    : ANCHORS.filter(a => a[0] <= max).concat(
        ANCHORS[ANCHORS.length - 1][0] > max ? [[max, 2000, 200000]] : []
      );

  if (id <= anchors[0][0]) {
    const a = anchors[0];
    return { hours: a[1], messages: a[2] };
  }

  for (let i = 1; i < anchors.length; i++) {
    const b = anchors[i];
    const a = anchors[i - 1];
    if (id <= b[0]) {
      const hours = interpolate(a, b, id, 1);
      const messages = interpolate(a, b, id, 2);
      return {
        hours: Number(hours.toFixed(2)),
        messages: Math.round(messages)
      };
    }
  }

  return { hours: 2000, messages: 200000 };
}

function buildProgression(totalVehicles = 115) {
  const total = Math.max(1, Math.floor(Number(totalVehicles) || 115));
  return Array.from({ length: total }, (_, i) => ({
    vehicle: i + 1,
    ...getVehicleRequirement(i + 1, total)
  }));
}

function validateProgression(totalVehicles = 115) {
  const rows = buildProgression(totalVehicles);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].hours < rows[i - 1].hours || rows[i].messages < rows[i - 1].messages) {
      throw new Error(`Vehicle progression is not monotonic at vehicle ${rows[i].vehicle}`);
    }
  }
  return rows;
}

module.exports = {
  ANCHORS,
  getVehicleRequirement,
  buildProgression,
  validateProgression
};
