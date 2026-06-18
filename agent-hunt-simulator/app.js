const PREY_SCENARIOS = [
  {
    id: "small",
    label: "小型猎物",
    spawnProbability: 0.6,
    power: 5,
    meat: 10,
    risk: "高频、极弱、微肉",
    color: "#1f7a8c"
  },
  {
    id: "medium",
    label: "中型猎物",
    spawnProbability: 0.3,
    power: 20,
    meat: 50,
    risk: "中频、中坚、良肉",
    color: "#c05a3f"
  },
  {
    id: "large",
    label: "大型猎物",
    spawnProbability: 0.1,
    power: 50,
    meat: 150,
    risk: "罕见、致命、暴富",
    color: "#d9a441"
  }
];

const OVERALL_SCENARIO = {
  id: "overall",
  label: "总体环境",
  color: "#2f4858"
};

const state = {
  hiddenSeries: new Set(),
  dataset: null,
  lastConfig: null
};

const elements = {
  hunterPower: document.getElementById("hunterPower"),
  maxAgents: document.getElementById("maxAgents"),
  trials: document.getElementById("trials"),
  seed: document.getElementById("seed"),
  rerunButton: document.getElementById("rerunButton"),
  exportButton: document.getElementById("exportButton"),
  statusText: document.getElementById("statusText"),
  preyTableBody: document.getElementById("preyTableBody"),
  summaryGrid: document.getElementById("summaryGrid"),
  perAgentChart: document.getElementById("perAgentChart"),
  teamChart: document.getElementById("teamChart"),
  combinedChart: document.getElementById("combinedChart"),
  successChart: document.getElementById("successChart"),
  detailsTableBody: document.getElementById("detailsTableBody")
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readConfig() {
  return {
    hunterPower: clamp(Math.round(toNumber(elements.hunterPower.value, 10)), 1, 100),
    maxAgents: clamp(Math.round(toNumber(elements.maxAgents.value, 30)), 2, 100),
    trials: clamp(Math.round(toNumber(elements.trials.value, 5000)), 100, 50000),
    seed: clamp(Math.round(toNumber(elements.seed.value, 20260617)), 1, 999999999)
  };
}

function syncInputs(config) {
  elements.hunterPower.value = String(config.hunterPower);
  elements.maxAgents.value = String(config.maxAgents);
  elements.trials.value = String(config.trials);
  elements.seed.value = String(config.seed);
}

function formatNumber(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function formatPercent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function computeOutcome(prey, agentCount, hunterPower) {
  const teamPower = agentCount * hunterPower;
  const successRate = teamPower / (teamPower + prey.power);
  const perAgentExpectation = successRate * (prey.meat / agentCount);
  const teamExpectation = successRate * prey.meat;

  return {
    successRate,
    perAgentExpectation,
    teamExpectation
  };
}

function computeOverallTheory(agentCount, hunterPower) {
  return PREY_SCENARIOS.reduce(
    (accumulator, prey) => {
      const outcome = computeOutcome(prey, agentCount, hunterPower);
      accumulator.perAgentExpectation += prey.spawnProbability * outcome.perAgentExpectation;
      accumulator.teamExpectation += prey.spawnProbability * outcome.teamExpectation;
      accumulator.successRate += prey.spawnProbability * outcome.successRate;
      return accumulator;
    },
    {
      perAgentExpectation: 0,
      teamExpectation: 0,
      successRate: 0
    }
  );
}

function pickPrey(random) {
  const roll = random();
  let threshold = 0;

  for (const prey of PREY_SCENARIOS) {
    threshold += prey.spawnProbability;
    if (roll <= threshold) {
      return prey;
    }
  }

  return PREY_SCENARIOS[PREY_SCENARIOS.length - 1];
}

function simulateScenario(agentCount, hunterPower, trials, seed, scenario) {
  const random = mulberry32(seed);
  let teamSum = 0;
  let successCount = 0;

  for (let attempt = 0; attempt < trials; attempt += 1) {
    const prey = scenario.id === "overall" ? pickPrey(random) : scenario;
    const successRate = (agentCount * hunterPower) / (agentCount * hunterPower + prey.power);
    const success = random() < successRate;
    if (success) {
      successCount += 1;
      teamSum += prey.meat;
    }
  }

  return {
    perAgentExpectation: teamSum / trials / agentCount,
    teamExpectation: teamSum / trials,
    successRate: successCount / trials
  };
}

function buildDataset(config) {
  const agentCounts = Array.from({ length: config.maxAgents }, (_, index) => index + 1);
  const scenarios = [...PREY_SCENARIOS, OVERALL_SCENARIO];
  const seriesByScenario = scenarios.map((scenario, scenarioIndex) => {
    const theoryPerAgent = [];
    const simulationPerAgent = [];
    const theoryTeam = [];
    const simulationTeam = [];
    const theorySuccess = [];
    const simulationSuccess = [];

    for (const agentCount of agentCounts) {
      const theory =
        scenario.id === "overall"
          ? computeOverallTheory(agentCount, config.hunterPower)
          : computeOutcome(scenario, agentCount, config.hunterPower);

      const simulation = simulateScenario(
        agentCount,
        config.hunterPower,
        config.trials,
        config.seed + scenarioIndex * 1000003 + agentCount * 7919,
        scenario
      );

      theoryPerAgent.push(theory.perAgentExpectation);
      simulationPerAgent.push(simulation.perAgentExpectation);
      theoryTeam.push(theory.teamExpectation);
      simulationTeam.push(simulation.teamExpectation);
      theorySuccess.push(theory.successRate);
      simulationSuccess.push(simulation.successRate);
    }

    return {
      ...scenario,
      theoryPerAgent,
      simulationPerAgent,
      theoryTeam,
      simulationTeam,
      theorySuccess,
      simulationSuccess
    };
  });

  return {
    agentCounts,
    config,
    seriesByScenario
  };
}

function getSelectedAgentCounts(maxAgents) {
  const candidatePoints = [1, 2, 5, 10, 20, maxAgents];
  return candidatePoints.filter((value, index) => value <= maxAgents && candidatePoints.indexOf(value) === index);
}

function renderPreyTable() {
  elements.preyTableBody.innerHTML = PREY_SCENARIOS.map(
    (prey) => `
      <tr>
        <td>${prey.label}</td>
        <td>${formatPercent(prey.spawnProbability, 0)}</td>
        <td>${prey.power}</td>
        <td>${prey.meat}</td>
        <td>${prey.risk}</td>
      </tr>
    `
  ).join("");
}

function makeSummaryCard(title, metric, copy) {
  return `
    <article class="summary-card">
      <h3>${title}</h3>
      <span class="summary-metric">${metric}</span>
      <p class="summary-copy">${copy}</p>
    </article>
  `;
}

function findLargePreyHalfSuccessPoint(hunterPower) {
  return Math.ceil(PREY_SCENARIOS.find((prey) => prey.id === "large").power / hunterPower);
}

function renderSummary(dataset) {
  const overall = dataset.seriesByScenario.find((scenario) => scenario.id === "overall");
  const medium = dataset.seriesByScenario.find((scenario) => scenario.id === "medium");
  const large = dataset.seriesByScenario.find((scenario) => scenario.id === "large");
  const bestSoloValue = overall.theoryPerAgent[0];
  const maxIndex = dataset.agentCounts.length - 1;
  const lastAgentCount = dataset.agentCounts[maxIndex];
  const largeHalfSuccessAgentCount = findLargePreyHalfSuccessPoint(dataset.config.hunterPower);
  const mediumAtFiveIndex = dataset.agentCounts.indexOf(5);
  const mediumAtFiveValue =
    mediumAtFiveIndex >= 0 ? formatNumber(medium.theoryPerAgent[mediumAtFiveIndex]) : "N/A";

  elements.summaryGrid.innerHTML = [
    makeSummaryCard(
      "总体环境下的独狼上限",
      `${formatNumber(bestSoloValue)}`,
      "按 PDF 的分配公式，单个 Agent 的期望出肉量在 N = 1 时最高，之后会随分摊人数增加而单调下降。"
    ),
    makeSummaryCard(
      "总体团队期望出肉量",
      `${formatNumber(overall.theoryTeam[maxIndex])}`,
      `当 N = ${lastAgentCount} 时，总体环境下的团队期望出肉量已经非常接近环境的理论上限 36。`
    ),
    makeSummaryCard(
      "大型猎物 50% 胜率门槛",
      `N = ${largeHalfSuccessAgentCount}`,
      `大型猎物的战斗力为 50。要让胜率达到或超过 50%，需要满足 N x C_h >= 50。当前参数下门槛是 ${largeHalfSuccessAgentCount} 个 Agent。`
    ),
    makeSummaryCard(
      "PDF 示例复现",
      mediumAtFiveIndex >= 0 ? `${mediumAtFiveValue}` : formatNumber(large.theoryPerAgent[0]),
      mediumAtFiveIndex >= 0
        ? `中型猎物在 N = 5 时，单个 Agent 的理论期望出肉量为 ${mediumAtFiveValue}，与 PDF 中给出的 7.14 一致。`
        : "当前最大 Agent 数小于 5，因此这里展示了最接近 PDF 示例的可用结果。"
    )
  ].join("");
}

function renderDetailsTable(dataset) {
  const overall = dataset.seriesByScenario.find((scenario) => scenario.id === "overall");
  const selectedCounts = getSelectedAgentCounts(dataset.config.maxAgents);

  elements.detailsTableBody.innerHTML = selectedCounts
    .map((agentCount) => {
      const index = agentCount - 1;
      return `
        <tr>
          <td>${agentCount}</td>
          <td>${formatNumber(overall.theoryPerAgent[index])}</td>
          <td>${formatNumber(overall.simulationPerAgent[index])}</td>
          <td>${formatNumber(overall.theoryTeam[index])}</td>
          <td>${formatNumber(overall.simulationTeam[index])}</td>
          <td>${formatPercent(overall.theorySuccess[index])}</td>
          <td>${formatPercent(overall.simulationSuccess[index])}</td>
        </tr>
      `;
    })
    .join("");
}

function createTicks(maxValue, tickCount, isPercent) {
  if (isPercent) {
    return [0, 0.25, 0.5, 0.75, 1];
  }

  const safeMax = Math.max(maxValue, 1);
  const roughStep = safeMax / (tickCount - 1);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;

  let niceFactor = 1;
  if (normalized > 5) {
    niceFactor = 10;
  } else if (normalized > 2) {
    niceFactor = 5;
  } else if (normalized > 1) {
    niceFactor = 2;
  }

  const step = niceFactor * magnitude;
  const ceiling = Math.ceil(safeMax / step) * step;
  const ticks = [];
  for (let value = 0; value <= ceiling + step / 2; value += step) {
    ticks.push(value);
  }
  return ticks;
}

function createXTickValues(maxAgents) {
  const desired = Math.min(6, maxAgents);
  const ticks = new Set([1, maxAgents]);

  for (let index = 1; index < desired - 1; index += 1) {
    const value = Math.round(1 + (index * (maxAgents - 1)) / (desired - 1));
    ticks.add(value);
  }

  return Array.from(ticks).sort((left, right) => left - right);
}

function linePath(values, xValues, xScale, yScale) {
  return values
    .map((value, index) => {
      const x = xScale(xValues[index]);
      const y = yScale(value);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function createChartSeries(dataset, metricPrefix) {
  return dataset.seriesByScenario.flatMap((scenario) => [
    {
      id: `${scenario.id}-${metricPrefix}-theory`,
      label: `${scenario.label} 理论`,
      color: scenario.color,
      strokeStyle: "solid",
      values: scenario[`theory${metricPrefix}`]
    },
    {
      id: `${scenario.id}-${metricPrefix}-simulation`,
      label: `${scenario.label} 模拟`,
      color: scenario.color,
      strokeStyle: "dashed",
      values: scenario[`simulation${metricPrefix}`]
    }
  ]);
}

function createCombinedComparisonSeries(dataset) {
  const overall = dataset.seriesByScenario.find((scenario) => scenario.id === "overall");

  return [
    {
      id: "combined-per-agent-theory",
      label: "个体收益理论",
      color: "#2f4858",
      strokeStyle: "solid",
      axis: "left",
      values: overall.theoryPerAgent
    },
    {
      id: "combined-per-agent-simulation",
      label: "个体收益模拟",
      color: "#2f4858",
      strokeStyle: "dashed",
      axis: "left",
      values: overall.simulationPerAgent
    },
    {
      id: "combined-team-theory",
      label: "群体收益理论",
      color: "#3f6f52",
      strokeStyle: "solid",
      axis: "right",
      values: overall.theoryTeam
    },
    {
      id: "combined-team-simulation",
      label: "群体收益模拟",
      color: "#3f6f52",
      strokeStyle: "dashed",
      axis: "right",
      values: overall.simulationTeam
    }
  ];
}

function renderLegend(mount, series) {
  const legend = document.createElement("div");
  legend.className = "legend";

  for (const item of series) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `legend-chip${state.hiddenSeries.has(item.id) ? " is-muted" : ""}`;
    chip.innerHTML = `
      <span class="legend-line ${item.strokeStyle === "dashed" ? "is-dashed" : ""}" style="border-top-color: ${item.color};"></span>
      <span>${item.label}</span>
    `;
    chip.addEventListener("click", () => {
      if (state.hiddenSeries.has(item.id)) {
        state.hiddenSeries.delete(item.id);
      } else {
        state.hiddenSeries.add(item.id);
      }
      renderVisuals();
    });
    legend.appendChild(chip);
  }

  mount.appendChild(legend);
}

function renderChart(mount, dataset, options) {
  mount.innerHTML = "";

  const series = options.series.filter((item) => !state.hiddenSeries.has(item.id));
  if (series.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前所有曲线都被隐藏了，可以点击图例重新显示。";
    mount.appendChild(empty);
    renderLegend(mount, options.series);
    return;
  }

  const frame = document.createElement("div");
  frame.className = "chart-frame";
  mount.appendChild(frame);

  const width = 840;
  const height = 420;
  const margin = { top: 18, right: 26, bottom: 48, left: 70 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const allValues = series.flatMap((item) => item.values);
  const maxValue = options.isPercent ? 1 : Math.max(...allValues, 1) * 1.05;
  const xValues = dataset.agentCounts;
  const yTicks = createTicks(maxValue, 6, options.isPercent);
  const xTicks = createXTickValues(dataset.config.maxAgents);
  const yMax = yTicks[yTicks.length - 1] || 1;

  const xScale = (value) => {
    if (xValues.length === 1) {
      return margin.left + plotWidth / 2;
    }
    return margin.left + ((value - xValues[0]) / (xValues[xValues.length - 1] - xValues[0])) * plotWidth;
  };

  const yScale = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", options.ariaLabel);

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", "0");
  background.setAttribute("y", "0");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", "transparent");
  svg.appendChild(background);

  for (const tick of yTicks) {
    const y = yScale(tick);
    const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    gridLine.setAttribute("x1", String(margin.left));
    gridLine.setAttribute("y1", y.toFixed(2));
    gridLine.setAttribute("x2", String(width - margin.right));
    gridLine.setAttribute("y2", y.toFixed(2));
    gridLine.setAttribute("stroke", "rgba(47, 72, 88, 0.12)");
    gridLine.setAttribute("stroke-width", "1");
    svg.appendChild(gridLine);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(margin.left - 12));
    label.setAttribute("y", String(y + 5));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("fill", "#5f6c72");
    label.setAttribute("font-size", "13");
    label.textContent = options.isPercent ? formatPercent(tick, 0) : formatNumber(tick, tick >= 10 ? 0 : 1);
    svg.appendChild(label);
  }

  for (const tick of xTicks) {
    const x = xScale(tick);
    const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    gridLine.setAttribute("x1", x.toFixed(2));
    gridLine.setAttribute("y1", String(margin.top));
    gridLine.setAttribute("x2", x.toFixed(2));
    gridLine.setAttribute("y2", String(height - margin.bottom));
    gridLine.setAttribute("stroke", "rgba(47, 72, 88, 0.08)");
    gridLine.setAttribute("stroke-width", "1");
    svg.appendChild(gridLine);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", String(height - margin.bottom + 24));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#5f6c72");
    label.setAttribute("font-size", "13");
    label.textContent = String(tick);
    svg.appendChild(label);
  }

  const axisX = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axisX.setAttribute("x1", String(margin.left));
  axisX.setAttribute("y1", String(height - margin.bottom));
  axisX.setAttribute("x2", String(width - margin.right));
  axisX.setAttribute("y2", String(height - margin.bottom));
  axisX.setAttribute("stroke", "#20303a");
  axisX.setAttribute("stroke-width", "1.4");
  svg.appendChild(axisX);

  const axisY = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axisY.setAttribute("x1", String(margin.left));
  axisY.setAttribute("y1", String(margin.top));
  axisY.setAttribute("x2", String(margin.left));
  axisY.setAttribute("y2", String(height - margin.bottom));
  axisY.setAttribute("stroke", "#20303a");
  axisY.setAttribute("stroke-width", "1.4");
  svg.appendChild(axisY);

  for (const item of series) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", linePath(item.values, xValues, xScale, yScale));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", item.color);
    path.setAttribute("stroke-width", item.strokeStyle === "dashed" ? "2.6" : "3.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (item.strokeStyle === "dashed") {
      path.setAttribute("stroke-dasharray", "8 7");
      path.setAttribute("opacity", "0.8");
    }
    svg.appendChild(path);
  }

  const xAxisLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  xAxisLabel.setAttribute("x", String(margin.left + plotWidth / 2));
  xAxisLabel.setAttribute("y", String(height - 8));
  xAxisLabel.setAttribute("text-anchor", "middle");
  xAxisLabel.setAttribute("fill", "#20303a");
  xAxisLabel.setAttribute("font-size", "14");
  xAxisLabel.textContent = "Agent 数量 N";
  svg.appendChild(xAxisLabel);

  const yAxisLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  yAxisLabel.setAttribute("x", "22");
  yAxisLabel.setAttribute("y", String(margin.top + plotHeight / 2));
  yAxisLabel.setAttribute("text-anchor", "middle");
  yAxisLabel.setAttribute("fill", "#20303a");
  yAxisLabel.setAttribute("font-size", "14");
  yAxisLabel.setAttribute("transform", `rotate(-90 22 ${margin.top + plotHeight / 2})`);
  yAxisLabel.textContent = options.yAxisLabel;
  svg.appendChild(yAxisLabel);

  frame.appendChild(svg);

  renderLegend(mount, options.series);

  const caption = document.createElement("p");
  caption.className = "chart-caption";
  caption.textContent = options.caption;
  mount.appendChild(caption);
}

function renderDualAxisChart(mount, dataset, options) {
  mount.innerHTML = "";

  const visibleSeries = options.series.filter((item) => !state.hiddenSeries.has(item.id));
  if (visibleSeries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前所有曲线都被隐藏了，可以点击图例重新显示。";
    mount.appendChild(empty);
    renderLegend(mount, options.series);
    return;
  }

  const leftAllValues = options.series.filter((item) => item.axis === "left").flatMap((item) => item.values);
  const rightAllValues = options.series.filter((item) => item.axis === "right").flatMap((item) => item.values);
  const leftTicks = createTicks(Math.max(...leftAllValues, 1) * 1.05, 6, false);
  const rightTicks = createTicks(Math.max(...rightAllValues, 1) * 1.05, 6, false);
  const leftMax = leftTicks[leftTicks.length - 1] || 1;
  const rightMax = rightTicks[rightTicks.length - 1] || 1;

  const frame = document.createElement("div");
  frame.className = "chart-frame";
  mount.appendChild(frame);

  const width = 840;
  const height = 420;
  const margin = { top: 18, right: 82, bottom: 48, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xValues = dataset.agentCounts;
  const xTicks = createXTickValues(dataset.config.maxAgents);

  const xScale = (value) => {
    if (xValues.length === 1) {
      return margin.left + plotWidth / 2;
    }
    return margin.left + ((value - xValues[0]) / (xValues[xValues.length - 1] - xValues[0])) * plotWidth;
  };

  const yScaleLeft = (value) => margin.top + plotHeight - (value / leftMax) * plotHeight;
  const yScaleRight = (value) => margin.top + plotHeight - (value / rightMax) * plotHeight;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", options.ariaLabel);

  for (const tick of leftTicks) {
    const y = yScaleLeft(tick);
    const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    gridLine.setAttribute("x1", String(margin.left));
    gridLine.setAttribute("y1", y.toFixed(2));
    gridLine.setAttribute("x2", String(width - margin.right));
    gridLine.setAttribute("y2", y.toFixed(2));
    gridLine.setAttribute("stroke", "rgba(47, 72, 88, 0.12)");
    gridLine.setAttribute("stroke-width", "1");
    svg.appendChild(gridLine);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(margin.left - 12));
    label.setAttribute("y", String(y + 5));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("fill", "#2f4858");
    label.setAttribute("font-size", "13");
    label.textContent = formatNumber(tick, tick >= 10 ? 0 : 1);
    svg.appendChild(label);
  }

  for (const tick of rightTicks) {
    const y = yScaleRight(tick);
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(width - margin.right + 12));
    label.setAttribute("y", String(y + 5));
    label.setAttribute("text-anchor", "start");
    label.setAttribute("fill", "#3f6f52");
    label.setAttribute("font-size", "13");
    label.textContent = formatNumber(tick, tick >= 10 ? 0 : 1);
    svg.appendChild(label);
  }

  for (const tick of xTicks) {
    const x = xScale(tick);
    const gridLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    gridLine.setAttribute("x1", x.toFixed(2));
    gridLine.setAttribute("y1", String(margin.top));
    gridLine.setAttribute("x2", x.toFixed(2));
    gridLine.setAttribute("y2", String(height - margin.bottom));
    gridLine.setAttribute("stroke", "rgba(47, 72, 88, 0.08)");
    gridLine.setAttribute("stroke-width", "1");
    svg.appendChild(gridLine);

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", String(height - margin.bottom + 24));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#5f6c72");
    label.setAttribute("font-size", "13");
    label.textContent = String(tick);
    svg.appendChild(label);
  }

  const axisX = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axisX.setAttribute("x1", String(margin.left));
  axisX.setAttribute("y1", String(height - margin.bottom));
  axisX.setAttribute("x2", String(width - margin.right));
  axisX.setAttribute("y2", String(height - margin.bottom));
  axisX.setAttribute("stroke", "#20303a");
  axisX.setAttribute("stroke-width", "1.4");
  svg.appendChild(axisX);

  const axisLeft = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axisLeft.setAttribute("x1", String(margin.left));
  axisLeft.setAttribute("y1", String(margin.top));
  axisLeft.setAttribute("x2", String(margin.left));
  axisLeft.setAttribute("y2", String(height - margin.bottom));
  axisLeft.setAttribute("stroke", "#2f4858");
  axisLeft.setAttribute("stroke-width", "1.4");
  svg.appendChild(axisLeft);

  const axisRight = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axisRight.setAttribute("x1", String(width - margin.right));
  axisRight.setAttribute("y1", String(margin.top));
  axisRight.setAttribute("x2", String(width - margin.right));
  axisRight.setAttribute("y2", String(height - margin.bottom));
  axisRight.setAttribute("stroke", "#3f6f52");
  axisRight.setAttribute("stroke-width", "1.4");
  svg.appendChild(axisRight);

  for (const item of visibleSeries) {
    const yScale = item.axis === "left" ? yScaleLeft : yScaleRight;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", linePath(item.values, xValues, xScale, yScale));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", item.color);
    path.setAttribute("stroke-width", item.strokeStyle === "dashed" ? "2.6" : "3.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (item.strokeStyle === "dashed") {
      path.setAttribute("stroke-dasharray", "8 7");
      path.setAttribute("opacity", "0.82");
    }
    svg.appendChild(path);
  }

  const xAxisLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  xAxisLabel.setAttribute("x", String(margin.left + plotWidth / 2));
  xAxisLabel.setAttribute("y", String(height - 8));
  xAxisLabel.setAttribute("text-anchor", "middle");
  xAxisLabel.setAttribute("fill", "#20303a");
  xAxisLabel.setAttribute("font-size", "14");
  xAxisLabel.textContent = "Agent 数量 N";
  svg.appendChild(xAxisLabel);

  const leftAxisLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  leftAxisLabel.setAttribute("x", "22");
  leftAxisLabel.setAttribute("y", String(margin.top + plotHeight / 2));
  leftAxisLabel.setAttribute("text-anchor", "middle");
  leftAxisLabel.setAttribute("fill", "#2f4858");
  leftAxisLabel.setAttribute("font-size", "14");
  leftAxisLabel.setAttribute("transform", `rotate(-90 22 ${margin.top + plotHeight / 2})`);
  leftAxisLabel.textContent = "个体收益";
  svg.appendChild(leftAxisLabel);

  const rightAxisLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  rightAxisLabel.setAttribute("x", String(width - 18));
  rightAxisLabel.setAttribute("y", String(margin.top + plotHeight / 2));
  rightAxisLabel.setAttribute("text-anchor", "middle");
  rightAxisLabel.setAttribute("fill", "#3f6f52");
  rightAxisLabel.setAttribute("font-size", "14");
  rightAxisLabel.setAttribute("transform", `rotate(90 ${width - 18} ${margin.top + plotHeight / 2})`);
  rightAxisLabel.textContent = "群体收益";
  svg.appendChild(rightAxisLabel);

  frame.appendChild(svg);

  renderLegend(mount, options.series);

  const caption = document.createElement("p");
  caption.className = "chart-caption";
  caption.textContent = options.caption;
  mount.appendChild(caption);
}

function exportCsv(dataset) {
  const header = [
    "scenario",
    "agent_count",
    "theory_per_agent",
    "simulation_per_agent",
    "theory_team",
    "simulation_team",
    "theory_success_rate",
    "simulation_success_rate"
  ];

  const rows = [header.join(",")];

  for (const scenario of dataset.seriesByScenario) {
    for (let index = 0; index < dataset.agentCounts.length; index += 1) {
      rows.push(
        [
          scenario.label,
          dataset.agentCounts[index],
          scenario.theoryPerAgent[index].toFixed(6),
          scenario.simulationPerAgent[index].toFixed(6),
          scenario.theoryTeam[index].toFixed(6),
          scenario.simulationTeam[index].toFixed(6),
          scenario.theorySuccess[index].toFixed(6),
          scenario.simulationSuccess[index].toFixed(6)
        ].join(",")
      );
    }
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `agent-hunt-simulation-N${dataset.config.maxAgents}-seed${dataset.config.seed}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function renderVisuals() {
  if (!state.dataset) {
    return;
  }

  renderSummary(state.dataset);
  renderDetailsTable(state.dataset);

  renderChart(elements.perAgentChart, state.dataset, {
    series: createChartSeries(state.dataset, "PerAgent"),
    yAxisLabel: "单个 Agent 期望出肉量",
    ariaLabel: "单个 Agent 期望出肉量折线图",
    caption: "按公式推导，单个 Agent 的期望出肉量会随着 N 增加而下降；模拟曲线会在理论值附近轻微波动。",
    isPercent: false
  });

  renderChart(elements.teamChart, state.dataset, {
    series: createChartSeries(state.dataset, "Team"),
    yAxisLabel: "团队总期望出肉量",
    ariaLabel: "团队总期望出肉量折线图",
    caption: "团队总期望出肉量与单人视角相反，会随着 N 增加而上升并逐渐逼近猎物总出肉量上限。",
    isPercent: false
  });

  renderDualAxisChart(elements.combinedChart, state.dataset, {
    series: createCombinedComparisonSeries(state.dataset),
    ariaLabel: "总体环境下群体收益与个体收益双轴对照图",
    caption: "这张图只看总体环境。左轴是单个 Agent 的期望收益，右轴是整个队伍的期望收益，可以直接看出两者随 N 变化的方向正好相反。"
  });

  renderChart(elements.successChart, state.dataset, {
    series: createChartSeries(state.dataset, "Success"),
    yAxisLabel: "捕猎成功率",
    ariaLabel: "捕猎成功率折线图",
    caption: "这张图对应 PDF 中“群体平滑风险”的结论，尤其能看出大型猎物在组队时胜率提升最明显。",
    isPercent: true
  });
}

function runSimulation() {
  const config = readConfig();
  syncInputs(config);
  elements.statusText.textContent = `正在按 C_h = ${config.hunterPower}、最大 N = ${config.maxAgents}、每点 ${config.trials} 次模拟重新计算。`;

  window.requestAnimationFrame(() => {
    state.dataset = buildDataset(config);
    state.lastConfig = config;
    renderVisuals();
    elements.statusText.textContent = `模拟完成。固定种子 ${config.seed} 已应用，虚线为每个点 ${config.trials} 次抽样得到的均值。`;
  });
}

elements.rerunButton.addEventListener("click", runSimulation);
elements.exportButton.addEventListener("click", () => {
  if (state.dataset) {
    exportCsv(state.dataset);
    elements.statusText.textContent = "CSV 已导出，文件名中包含当前最大 N 和随机种子。";
  }
});

renderPreyTable();
runSimulation();
