/**
 * This source runs only inside QuickJS/WASM. It has no host callbacks, module loader,
 * filesystem, network, environment, timers or DOM. Its sole output is a JSON string.
 * The supervisor validates that string independently before trusted React sees it.
 */
export const lessonVisualKernel = String.raw`
(function executeScene(source, input, limits) {
  'use strict';
  const stringify = JSON.stringify.bind(JSON);
  const frames = [];
  let current = input;
  let outputCharacters = 0;
  const Fragment = Symbol('Fragment');
  const flatten = (values) => values.flat(Infinity).filter((value) => value !== null && value !== undefined && value !== false && value !== true);
  const createElement = (tag, supplied, ...children) => {
    const properties = supplied || {};
    const values = flatten(children.length ? children : [properties.children]);
    if (tag === Fragment) {
      return {tag: 'g', attributes: {}, children: values};
    }
    if (typeof tag === 'function') {
      return tag({...properties, children: values});
    }
    const attributes = {};
    for (const [name, value] of Object.entries(properties)) {
      if (name === 'key' || name === 'children' || value === undefined || value === null) continue;
      if (name === 'style' && typeof value === 'object') Object.assign(attributes, value);
      else attributes[name] = value;
    }
    return {tag, attributes, children: values.map((value) => typeof value === 'number' ? String(value) : value)};
  };
  const React = Object.freeze({createElement, Fragment});
  const interpolate = (value, inputs, outputs, options = {}) => {
    if (inputs.length < 2 || inputs.length !== outputs.length) throw Error('interpolate requires equally sized input/output ranges.');
    let index = 0;
    while (index < inputs.length - 2 && value >= inputs[index + 1]) index += 1;
    let amount = (value - inputs[index]) / (inputs[index + 1] - inputs[index]);
    if (value < inputs[0] && options.extrapolateLeft === 'clamp') amount = 0;
    if (value > inputs[inputs.length - 1] && options.extrapolateRight === 'clamp') amount = 1;
    return outputs[index] + amount * (outputs[index + 1] - outputs[index]);
  };
  const spring = ({frame, fps, config = {}, from = 0, to = 1}) => {
    const time = Math.max(0, frame / fps);
    const stiffness = config.stiffness || 100;
    const mass = config.mass || 1;
    const damping = config.damping || 10;
    const frequency = Math.sqrt(stiffness / mass);
    const ratio = damping / (2 * Math.sqrt(stiffness * mass));
    const damped = frequency * Math.sqrt(Math.max(0, 1 - ratio * ratio));
    const progress = ratio >= 1 ? 1 - Math.exp(-frequency * time) * (1 + frequency * time) : 1 - Math.exp(-ratio * frequency * time) * (Math.cos(damped * time) + ratio * frequency / damped * Math.sin(damped * time));
    return from + (to - from) * progress;
  };
  const remotion = Object.freeze({
    useCurrentFrame: () => current.frame,
    useVideoConfig: () => ({fps: current.fps, width: current.width, height: current.height, durationInFrames: current.durationInFrames}),
    interpolate,
    spring,
  });
  const require = (name) => {
    if (name === 'react') return {...React, default: React};
    if (name === 'remotion') return remotion;
    throw Error('Unsupported import.');
  };
  globalThis.Date = undefined;
  Math.random = () => {throw Error('Randomness is unsupported; derive animation from frame.');};
  const module = {exports: {}};
  new Function('require', 'module', 'exports', 'React', source)(require, module, module.exports, React);
  const Scene = module.exports.default;
  if (typeof Scene !== 'function') throw Error('Export a synchronous default Scene component.');
  for (let frame = 0; frame < input.durationInFrames; frame += 1) {
    current = Object.freeze({...input, frame});
    const tree = Scene(current);
    const serialized = stringify(tree);
    if (typeof serialized !== 'string') throw Error('Return an SVG component.');
    if (serialized.length > limits.frameCharacters) throw Error('The SVG frame exceeds the output limit.');
    outputCharacters += serialized.length;
    if (outputCharacters > limits.outputCharacters) throw Error('The animation exceeds the output limit.');
    frames.push(serialized);
  }
  return '[' + frames.join(',') + ']';
})
`;
