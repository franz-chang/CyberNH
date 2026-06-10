class SeededRng {
  constructor(seed = 42) {
    this.state = (Number(seed) >>> 0) || 42;
  }

  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min, max) {
    return min + (max - min) * this.next();
  }

  int(min, max) {
    return Math.floor(this.uniform(min, max + 1));
  }

  pick(items) {
    if (!items.length) return null;
    return items[this.int(0, items.length - 1)];
  }

  weightedPick(weightMap) {
    const entries = Object.entries(weightMap).filter(([, weight]) => weight > 0);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (total <= 0 || entries.length === 0) return null;
    let roll = this.uniform(0, total);
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return key;
    }
    return entries[entries.length - 1][0];
  }

  triangular(min, mode, max) {
    const u = this.next();
    const c = (mode - min) / (max - min);
    if (u < c) {
      return min + Math.sqrt(u * (max - min) * (mode - min));
    }
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[clamp(index, 0, sorted.length - 1)];
}

function gini(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  const weighted = sorted.reduce((sum, value, index) => sum + (index + 1) * value, 0);
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

module.exports = { SeededRng, clamp, percentile, gini };
