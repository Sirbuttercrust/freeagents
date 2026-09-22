/*! bot-avatars 0.1.1, the non-React core (src/ minus BotAvatar.tsx).
 * Copyright (c) 2026 Jakub Antalik. MIT License, full text in ./LICENSE.
 * Vendored at commit 5a455ed8102ecb18b7b9800c73fa5be2ee9527ec, bundled unmodified by
 * scripts/vendor-bot-avatars.mjs into one script that sets window.BotAvatars.
 * See ./VENDORED.md. */
"use strict";
var BotAvatars = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/__freeagents_entry.ts
  var freeagents_entry_exports = {};
  __export(freeagents_entry_exports, {
    BOT_AVATAR_OVERSCAN: () => OVERSCAN,
    BOT_AVATAR_RISE: () => RISE,
    BotAvatarSim: () => Sim,
    autoInk: () => autoInk,
    botAvatarFaces: () => botAvatarFaces,
    botAvatarParts: () => SHAPE_PARTS,
    botAvatarPointer: () => pointer,
    botAvatarPresets: () => botAvatarPresets,
    botAvatarShapes: () => SHAPE_PATHS,
    botAvatarStates: () => botAvatarStates,
    botAvatarTypes: () => botAvatarTypes,
    drawBotAvatarFrame: () => draw,
    luminance: () => luminance,
    parseColor: () => parseColor,
    restPose: () => restPose,
    shade: () => shade,
    subscribeBotAvatarTicker: () => subscribe,
    warmBotAvatarPlastic: () => warmPlastic
  });

  // src/presets.ts
  var botAvatarPresets = {
    clover: { label: "Clover", color: "#35B8FF", face: "eyes", faceX: 50, faceY: 50, faceScale: 1 },
    flower: { label: "Flower", color: "#2FCB7A", face: "eyes", faceX: 50, faceY: 51, faceScale: 0.95 },
    triangle: { label: "Triangle", color: "#DC48FF", face: "eyes", faceX: 50, faceY: 61, faceScale: 0.9 },
    square: { label: "Square", color: "#35B8FF", face: "eyes", faceX: 50, faceY: 50, faceScale: 1 },
    blob: { label: "Blob", color: "#2FCB7A", face: "eyes", faceX: 49.5, faceY: 50, faceScale: 1 },
    ghost: { label: "Ghost", color: "#F4F2FA", face: "eyes", faceX: 50, faceY: 48, faceScale: 0.95 },
    circle: { label: "Circle", color: "#9A62FF", face: "eyes", faceX: 50, faceY: 50, faceScale: 1 },
    drop: { label: "Drop", color: "#1ED3C6", face: "eyes", faceX: 50, faceY: 62, faceScale: 0.9 },
    star: { label: "Star", color: "#FFD32B", face: "eyes", faceX: 50, faceY: 52, faceScale: 0.82 },
    droid: { label: "Droid", color: "#D5DBEA", face: "eyes", faceX: 50, faceY: 60, faceScale: 0.95 },
    mech: { label: "Mech", color: "#95A6C4", face: "eyes", faceX: 50, faceY: 59, faceScale: 1 },
    alien: { label: "Alien", color: "#9BE85A", face: "eyes", faceX: 50, faceY: 45, faceScale: 1.05 },
    hexagon: { label: "Hexagon", color: "#FF2A2A", face: "eyes", faceX: 50, faceY: 50, faceScale: 0.95 },
    cat: { label: "Cat", color: "#FF8C42", face: "eyes", faceX: 50, faceY: 58, faceScale: 1 },
    cloud: { label: "Cloud", color: "#CFE6FF", face: "eyes", faceX: 50, faceY: 58, faceScale: 0.95 },
    pill: { label: "Pill", color: "#7B77F0", face: "eyes", faceX: 50, faceY: 50, faceScale: 0.9 },
    pebble: { label: "Pebble", color: "#2FCB7A", face: "eyes", faceX: 50, faceY: 50, faceScale: 0.95 },
    puddle: { label: "Puddle", color: "#FF2A2A", face: "eyes", faceX: 50, faceY: 50, faceScale: 0.95 }
  };
  var botAvatarTypes = Object.keys(botAvatarPresets);
  var botAvatarFaces = ["eyes", "mouth"];
  var botAvatarStates = ["default", "working", "sleeping"];
  var botAvatarPalette = Object.fromEntries(
    botAvatarTypes.map((t) => [t, botAvatarPresets[t].color])
  );

  // src/shapes.ts
  var SHAPE_PATHS = {
    clover: "M26.53 22.38A25 25 0 0 1 73.47 22.38A7 7 0 0 0 77.62 26.53A25 25 0 0 1 77.62 73.47A7 7 0 0 0 73.47 77.62A25 25 0 0 1 26.53 77.62A7 7 0 0 0 22.38 73.47A25 25 0 0 1 22.38 26.53A7 7 0 0 0 26.53 22.38Z",
    flower: "M31.2 19.82A20.5 20.5 0 0 1 68.8 19.82A5 5 0 0 0 72.9 22.8A20.5 20.5 0 0 1 84.51 58.55A5 5 0 0 0 82.95 63.37A20.5 20.5 0 0 1 52.54 85.47A5 5 0 0 0 47.46 85.47A20.5 20.5 0 0 1 17.05 63.37A5 5 0 0 0 15.49 58.55A20.5 20.5 0 0 1 27.1 22.8A5 5 0 0 0 31.2 19.82Z",
    triangle: "M38.75 27.43A13 13 0 0 1 61.25 27.43L82.7 64.49A13 13 0 0 1 71.45 84L28.55 84A13 13 0 0 1 17.3 64.49L38.75 27.43Z",
    square: "M93 50C93 53.66 92.96 58.23 92.88 60.97C92.8 63.71 92.67 64.81 92.51 66.44C92.35 68.08 92.15 69.44 91.9 70.77C91.66 72.1 91.37 73.3 91.04 74.44C90.72 75.58 90.35 76.63 89.94 77.63C89.53 78.63 89.07 79.55 88.58 80.43C88.08 81.31 87.54 82.13 86.96 82.9C86.37 83.67 85.75 84.39 85.07 85.07C84.39 85.75 83.67 86.37 82.9 86.96C82.13 87.54 81.31 88.08 80.43 88.58C79.55 89.07 78.63 89.53 77.63 89.94C76.63 90.35 75.58 90.72 74.44 91.04C73.3 91.37 72.1 91.66 70.77 91.9C69.44 92.15 68.08 92.35 66.44 92.51C64.81 92.67 63.71 92.8 60.97 92.88C58.23 92.96 53.66 93 50 93C46.34 93 41.77 92.96 39.03 92.88C36.29 92.8 35.19 92.67 33.56 92.51C31.92 92.35 30.56 92.15 29.23 91.9C27.9 91.66 26.7 91.37 25.56 91.04C24.42 90.72 23.37 90.35 22.37 89.94C21.37 89.53 20.45 89.07 19.57 88.58C18.69 88.08 17.87 87.54 17.1 86.96C16.33 86.37 15.61 85.75 14.93 85.07C14.25 84.39 13.63 83.67 13.04 82.9C12.46 82.13 11.92 81.31 11.42 80.43C10.93 79.55 10.47 78.63 10.06 77.63C9.65 76.63 9.28 75.58 8.96 74.44C8.63 73.3 8.34 72.1 8.1 70.77C7.85 69.44 7.65 68.08 7.49 66.44C7.33 64.81 7.2 63.71 7.12 60.97C7.04 58.23 7 53.66 7 50C7 46.34 7.04 41.77 7.12 39.03C7.2 36.29 7.33 35.19 7.49 33.56C7.65 31.92 7.85 30.56 8.1 29.23C8.34 27.9 8.63 26.7 8.96 25.56C9.28 24.42 9.65 23.37 10.06 22.37C10.47 21.37 10.93 20.45 11.42 19.57C11.92 18.69 12.46 17.87 13.04 17.1C13.63 16.33 14.25 15.61 14.93 14.93C15.61 14.25 16.33 13.63 17.1 13.04C17.87 12.46 18.69 11.92 19.57 11.42C20.45 10.93 21.37 10.47 22.37 10.06C23.37 9.65 24.42 9.28 25.56 8.96C26.7 8.63 27.9 8.34 29.23 8.1C30.56 7.85 31.92 7.65 33.56 7.49C35.19 7.33 36.29 7.2 39.03 7.12C41.77 7.04 46.34 7 50 7C53.66 7 58.23 7.04 60.97 7.12C63.71 7.2 64.81 7.33 66.44 7.49C68.08 7.65 69.44 7.85 70.77 8.1C72.1 8.34 73.3 8.63 74.44 8.96C75.58 9.28 76.63 9.65 77.63 10.06C78.63 10.47 79.55 10.93 80.43 11.42C81.31 11.92 82.13 12.46 82.9 13.04C83.67 13.63 84.39 14.25 85.07 14.93C85.75 15.61 86.37 16.33 86.96 17.1C87.54 17.87 88.08 18.69 88.58 19.57C89.07 20.45 89.53 21.37 89.94 22.37C90.35 23.37 90.72 24.42 91.04 25.56C91.37 26.7 91.66 27.9 91.9 29.23C92.15 30.56 92.35 31.92 92.51 33.56C92.67 35.19 92.8 36.29 92.88 39.03C92.96 41.77 93 46.34 93 50Z",
    blob: "M93.92 50C94.18 51.9 94.24 53.9 93.99 55.79C93.73 57.68 93.18 59.61 92.39 61.36C91.6 63.1 90.48 64.78 89.27 66.27C88.07 67.76 86.58 69.08 85.14 70.29C83.7 71.49 82.1 72.5 80.62 73.5C79.14 74.49 77.64 75.34 76.24 76.24C74.84 77.15 73.51 78 72.2 78.93C70.88 79.86 69.66 80.83 68.36 81.8C67.06 82.76 65.78 83.82 64.39 84.74C63 85.67 61.55 86.63 60.01 87.35C58.47 88.08 56.82 88.73 55.15 89.1C53.48 89.47 51.71 89.64 50 89.57C48.29 89.5 46.55 89.16 44.91 88.68C43.27 88.21 41.67 87.47 40.16 86.72C38.65 85.96 37.24 85.02 35.86 84.13C34.48 83.24 33.19 82.29 31.89 81.37C30.58 80.46 29.32 79.56 28.03 78.63C26.74 77.71 25.44 76.82 24.16 75.84C22.88 74.86 21.57 73.87 20.36 72.74C19.15 71.62 17.95 70.42 16.91 69.1C15.88 67.79 14.92 66.35 14.15 64.85C13.38 63.35 12.76 61.73 12.29 60.1C11.81 58.48 11.52 56.78 11.29 55.1C11.06 53.41 10.98 51.71 10.91 50C10.83 48.29 10.83 46.59 10.83 44.84C10.84 43.1 10.85 41.34 10.93 39.53C11.02 37.72 11.09 35.86 11.34 33.99C11.59 32.12 11.88 30.16 12.43 28.31C12.99 26.46 13.69 24.56 14.66 22.88C15.64 21.21 16.86 19.58 18.27 18.27C19.69 16.96 21.4 15.84 23.17 15.03C24.93 14.22 26.95 13.71 28.89 13.43C30.83 13.15 32.9 13.21 34.82 13.36C36.74 13.5 38.66 13.92 40.43 14.28C42.2 14.65 43.87 15.16 45.46 15.54C47.06 15.93 48.52 16.31 50 16.58C51.48 16.85 52.87 17.02 54.32 17.17C55.77 17.32 57.22 17.36 58.71 17.49C60.2 17.62 61.74 17.7 63.28 17.95C64.81 18.19 66.39 18.5 67.91 18.98C69.43 19.46 70.95 20.08 72.38 20.83C73.81 21.58 75.19 22.5 76.5 23.5C77.81 24.5 79.03 25.63 80.22 26.81C81.41 27.99 82.54 29.25 83.65 30.57C84.76 31.89 85.85 33.26 86.89 34.72C87.93 36.18 88.98 37.69 89.9 39.31C90.82 40.92 91.73 42.64 92.4 44.42C93.07 46.2 93.66 48.1 93.92 50Z",
    ghost: "M17 50C17 31.78 31.78 17 50 17C68.22 17 83 31.78 83 50V81.5Q72 93.5 61 81.5Q50 93.5 39 81.5Q28 93.5 17 81.5Z",
    circle: "M50 8A42 42 0 1 1 50 92A42 42 0 1 1 50 8Z",
    drop: "M50 8.5C52.2 8.5 53.4 10.3 56.4 15.2C62.9 25.5 84 44.6 84 61.5C84 80.3 68.8 92 50 92C31.2 92 16 80.3 16 61.5C16 44.6 37.1 25.5 43.6 15.2C46.6 10.3 47.8 8.5 50 8.5Z",
    star: "M45.77 9.7A5 5 0 0 1 54.23 9.7L65.02 26.81A4 4 0 0 0 67.42 28.55L87.02 33.53A5 5 0 0 1 89.63 41.57L76.7 57.12A4 4 0 0 0 75.78 59.94L77.11 80.12A5 5 0 0 1 70.26 85.09L51.48 77.59A4 4 0 0 0 48.52 77.59L29.74 85.09A5 5 0 0 1 22.89 80.12L24.22 59.94A4 4 0 0 0 23.3 57.12L10.37 41.57A5 5 0 0 1 12.98 33.53L32.58 28.55A4 4 0 0 0 34.98 26.81L45.77 9.7Z",
    droid: "M16 50C16 38.95 24.95 30 36 30H64C75.05 30 84 38.95 84 50V70C84 81.05 75.05 90 64 90H36C24.95 90 16 81.05 16 70ZM4 62A7 7 0 1 1 18 62A7 7 0 1 1 4 62ZM82 62A7 7 0 1 1 96 62A7 7 0 1 1 82 62Z",
    mech: "M10 48C10 38.06 18.06 30 28 30H72C81.94 30 90 38.06 90 48V70C90 79.94 81.94 88 72 88H28C18.06 88 10 79.94 10 70ZM3 54C3 51.79 4.79 50 7 50H11V72H7C4.79 72 3 70.21 3 68ZM89 50H93C95.21 50 97 51.79 97 54V68C97 70.21 95.21 72 93 72H89Z",
    alien: "M50 10C70 10 83 27 83 46C83 65 64 92 50 92C36 92 17 65 17 46C17 27 30 10 50 10Z",
    hexagon: "M91.4 45.5A9 9 0 0 1 91.4 54.5L74.6 83.61A9 9 0 0 1 66.8 88.11L33.2 88.11A9 9 0 0 1 25.4 83.61L8.6 54.5A9 9 0 0 1 8.6 45.5L25.4 16.39A9 9 0 0 1 33.2 11.89L66.8 11.89A9 9 0 0 1 74.6 16.39L91.4 45.5Z",
    cat: "M50 20A36 36 0 1 1 50 92A36 36 0 1 1 50 20ZM24.72 44.64A4.5 4.5 0 0 1 17.35 40.67L20.21 16.66A4.5 4.5 0 0 1 26.86 13.26L42.3 21.83A4.5 4.5 0 0 1 43.02 29.21L24.72 44.64ZM82.65 40.67A4.5 4.5 0 0 1 75.28 44.64L56.98 29.21A4.5 4.5 0 0 1 57.7 21.83L73.14 13.26A4.5 4.5 0 0 1 79.79 16.66L82.65 40.67Z",
    cloud: "M19 44A25 25 0 1 1 69 44A25 25 0 1 1 19 44ZM47 50A21 21 0 1 1 89 50A21 21 0 1 1 47 50ZM7 68A17 17 0 1 1 41 68A17 17 0 1 1 7 68ZM32 73A18 18 0 1 1 68 73A18 18 0 1 1 32 73ZM60 70A16 16 0 1 1 92 70A16 16 0 1 1 60 70Z",
    pill: "M28 28H72C84.15 28 94 37.85 94 50C94 62.15 84.15 72 72 72H28C15.85 72 6 62.15 6 50C6 37.85 15.85 28 28 28Z",
    pebble: "M94.6 50C94.71 51.92 94.56 53.93 94.17 55.82C93.79 57.7 93.13 59.6 92.28 61.33C91.44 63.06 90.32 64.72 89.1 66.19C87.87 67.67 86.41 69.01 84.92 70.16C83.42 71.31 81.75 72.29 80.11 73.1C78.47 73.92 76.73 74.55 75.06 75.06C73.39 75.58 71.7 75.91 70.1 76.2C68.5 76.48 66.93 76.62 65.45 76.76C63.96 76.9 62.55 76.94 61.2 77.03C59.84 77.11 58.57 77.16 57.31 77.26C56.05 77.36 54.86 77.48 53.64 77.63C52.42 77.79 51.24 77.98 50 78.18C48.76 78.39 47.52 78.64 46.2 78.85C44.89 79.06 43.53 79.3 42.11 79.46C40.69 79.61 39.2 79.75 37.67 79.77C36.14 79.78 34.54 79.74 32.95 79.54C31.35 79.33 29.7 79.03 28.1 78.55C26.49 78.07 24.86 77.45 23.33 76.67C21.8 75.88 20.29 74.94 18.92 73.85C17.54 72.77 16.23 71.51 15.08 70.16C13.94 68.8 12.9 67.29 12.04 65.72C11.17 64.16 10.45 62.46 9.91 60.74C9.36 59.03 8.98 57.22 8.76 55.43C8.55 53.64 8.5 51.8 8.6 50C8.71 48.2 8.98 46.39 9.38 44.65C9.79 42.91 10.35 41.19 11.02 39.56C11.7 37.92 12.52 36.34 13.43 34.85C14.34 33.37 15.39 31.96 16.5 30.66C17.61 29.36 18.84 28.15 20.11 27.07C21.39 25.98 22.76 25 24.15 24.15C25.54 23.3 27.01 22.56 28.48 21.95C29.94 21.33 31.46 20.85 32.95 20.46C34.44 20.08 35.95 19.83 37.43 19.66C38.91 19.48 40.38 19.43 41.81 19.43C43.24 19.43 44.64 19.53 46.01 19.66C47.37 19.78 48.7 19.98 50 20.18C51.3 20.39 52.57 20.63 53.83 20.87C55.1 21.11 56.34 21.37 57.6 21.62C58.87 21.87 60.13 22.12 61.43 22.39C62.74 22.66 64.07 22.93 65.45 23.24C66.83 23.56 68.25 23.88 69.72 24.3C71.19 24.72 72.71 25.17 74.25 25.75C75.78 26.34 77.37 27 78.91 27.81C80.46 28.63 82.04 29.56 83.5 30.66C84.97 31.75 86.43 33 87.7 34.38C88.98 35.77 90.19 37.32 91.17 38.97C92.14 40.62 92.98 42.43 93.56 44.27C94.13 46.1 94.5 48.08 94.6 50Z",
    puddle: "M85.34 50C85.65 51.54 85.9 53.13 86.01 54.74C86.11 56.35 86.11 58 85.95 59.63C85.8 61.26 85.51 62.93 85.07 64.52C84.62 66.12 84.03 67.72 83.3 69.23C82.58 70.74 81.7 72.21 80.72 73.57C79.74 74.94 78.62 76.23 77.43 77.43C76.24 78.62 74.93 79.72 73.58 80.73C72.23 81.74 70.79 82.65 69.33 83.48C67.86 84.31 66.34 85.04 64.79 85.71C63.24 86.37 61.65 86.95 60.04 87.46C58.42 87.96 56.77 88.4 55.1 88.75C53.43 89.09 51.72 89.37 50 89.54C48.28 89.71 46.52 89.81 44.76 89.76C43.01 89.72 41.22 89.58 39.47 89.29C37.72 89 35.95 88.58 34.26 88C32.57 87.42 30.89 86.69 29.33 85.8C27.77 84.92 26.26 83.87 24.91 82.7C23.56 81.53 22.3 80.19 21.23 78.77C20.16 77.35 19.22 75.79 18.47 74.2C17.71 72.61 17.13 70.91 16.7 69.23C16.26 67.55 16.02 65.81 15.88 64.13C15.75 62.45 15.78 60.76 15.88 59.14C15.97 57.52 16.21 55.94 16.45 54.42C16.7 52.89 17.03 51.43 17.34 50C17.65 48.57 18 47.2 18.32 45.83C18.63 44.46 18.94 43.13 19.24 41.76C19.53 40.39 19.79 39.03 20.08 37.61C20.36 36.18 20.62 34.74 20.95 33.23C21.28 31.72 21.61 30.16 22.07 28.57C22.52 26.98 23.02 25.32 23.69 23.69C24.35 22.06 25.11 20.38 26.05 18.79C26.99 17.21 28.08 15.62 29.33 14.2C30.58 12.78 32 11.41 33.54 10.26C35.08 9.12 36.8 8.11 38.57 7.35C40.34 6.6 42.27 6.04 44.17 5.73C46.08 5.43 48.08 5.37 50 5.54C51.92 5.71 53.87 6.15 55.69 6.75C57.52 7.36 59.3 8.22 60.94 9.19C62.57 10.15 64.11 11.33 65.51 12.56C66.91 13.78 68.17 15.15 69.33 16.52C70.48 17.89 71.5 19.34 72.44 20.76C73.38 22.18 74.19 23.62 74.97 25.03C75.75 26.43 76.44 27.83 77.12 29.19C77.8 30.56 78.42 31.89 79.05 33.23C79.67 34.57 80.28 35.87 80.87 37.21C81.46 38.55 82.05 39.88 82.6 41.27C83.14 42.65 83.68 44.05 84.14 45.51C84.6 46.96 85.03 48.46 85.34 50Z"
  };
  var SHAPE_PARTS = {
    droid: "M47.5 14H52.5V32H47.5ZM43 11A7 7 0 1 1 57 11A7 7 0 1 1 43 11Z",
    mech: "M19.5 32L24.5 32L17 13L12 13ZM75.5 32L80.5 32L88 13L83 13ZM10 11.5A4.5 4.5 0 1 1 19 11.5A4.5 4.5 0 1 1 10 11.5ZM81 11.5A4.5 4.5 0 1 1 90 11.5A4.5 4.5 0 1 1 81 11.5Z"
  };

  // src/color.ts
  function parseColor(input) {
    const s = input.trim();
    const hsl = s.match(/^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i);
    if (hsl) return hslToRgb([Number(hsl[1]) / 360, Number(hsl[2]) / 100, Number(hsl[3]) / 100]);
    const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      let h = hex[1];
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      const n = parseInt(h, 16);
      return [n >> 16 & 255, n >> 8 & 255, n & 255];
    }
    const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return null;
  }
  function luminance(color) {
    const c = parseColor(color);
    if (!c) return 0.5;
    const lin = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  }
  var DARK_INK = "#1E1A33";
  var LIGHT_INK = "#F7F5F2";
  function autoInk(color) {
    return luminance(color) < 0.13 ? LIGHT_INK : DARK_INK;
  }
  function rgbToHsl([r, g, b]) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToRgb([h, s, l]) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      t = (t % 1 + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  function hslToCss([h, s, l]) {
    return `hsl(${(h * 360).toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
  }
  var clamp01 = (v) => Math.min(1, Math.max(0, v));
  function shade(color, dl, ds = 0) {
    const c = parseColor(color);
    if (!c) return color;
    const [h, s, l] = rgbToHsl(c);
    return hslToCss([h, clamp01(s + ds + (dl < 0 ? -dl * 0.25 : 0)), clamp01(l + dl)]);
  }

  // src/engine.ts
  var STATES = ["default", "working", "sleeping"];
  var HOP_T = 0.68;
  var HOP_SPIN_H = 26;
  var FLIP_PRE = 0.2;
  var JUMP_DEFAULTS = { height: HOP_SPIN_H, time: HOP_T, stretch: 1, squash: 1.15, squashTime: 0.37, squashEase: "pulse", groundTime: 0.11, groundEase: "pulse", riseTime: 0.33, riseEase: "pulse", clickSquashTime: 0.24, spin: 1, lean: 6, every: 8, land: 0 };
  var flipPre = (j, poked) => poked ? j.clickSquashTime : FLIP_PRE * j.time;
  var flipDuration = (j, poked) => flipPre(j, poked) + j.time + SQUASH_PEAK[j.squashEase] * (poked ? j.clickSquashTime : j.squashTime) + Math.max(0, j.groundTime) + j.riseTime + Math.max(0, j.land) + 0.05;
  var SQUASH_PEAK = { sharp: 0, pulse: 2 / 7, soft: 0.5, bouncy: 0.144 };
  var risePulse = (v, ease) => {
    if (v <= 0) return 1;
    if (v >= 1) return 0;
    switch (ease) {
      case "sharp":
        return (1 - v) * (1 - v);
      case "soft":
        return 0.5 + 0.5 * Math.cos(Math.PI * v);
      case "bouncy":
        return Math.exp(-3.2 * v) * Math.cos(5.4 * v) - v * v * v * 0.026;
      default: {
        const k = 4.2 * v;
        return (1 + k) * Math.exp(-k) - v * v * v * 0.078;
      }
    }
  };
  var groundShape = (v, ease) => 1 + 0.25 * squashPulse(v, ease);
  var squashPulse = (u, ease) => {
    if (u <= 0 || u >= 1) return 0;
    let x;
    switch (ease) {
      case "sharp":
        x = (1 - u) * (1 - u);
        break;
      case "soft":
        x = Math.sin(Math.PI * u) ** 2;
        break;
      case "bouncy":
        x = Math.exp(-3.15 * u) * Math.sin(8.43 * u) / 0.596;
        break;
      default: {
        const k = 7 * u;
        x = k * k * Math.exp(2 - k) / 4;
      }
    }
    const tail = u > 0.85 ? 1 - (u - 0.85) / 0.15 : 1;
    return x * tail * tail * (3 - 2 * tail);
  };
  var hopSquash = (a) => Math.exp(-Math.pow(Math.min(Math.abs(a), Math.abs(a - 1)) / 0.11, 2));
  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;
  var SWITCH_TO = { default: 1.2, working: 0.7, sleeping: 1.4 };
  var SWITCH_FROM_SLEEP = 1;
  function rng(seed) {
    let a = seed * 2654435761 >>> 0 || 1;
    return () => {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function approach(cur, target, rate, dt) {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }
  var easeInOut = (p) => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  var easeSine = (p) => 0.5 - 0.5 * Math.cos(Math.PI * p);
  var Wander = class {
    /* A channel that picks a new target now and then and moves to it. The
       head channels move as a lightly damped spring — the turn starts and
       ends softly, the way a head does — while the eyes dart with an
       exponential approach, the way eyes do. */
    constructor(rand, amp, holdMin, holdMax, rate, spring = false) {
      this.rand = rand;
      this.amp = amp;
      this.holdMin = holdMin;
      this.holdMax = holdMax;
      this.rate = rate;
      this.spring = spring;
      this.value = 0;
      this.vel = 0;
      this.target = 0;
      this.next = 0;
    }
    update(t, dt) {
      if (t >= this.next) {
        this.target = (this.rand() * 2 - 1) * this.amp;
        this.next = t + this.holdMin + this.rand() * (this.holdMax - this.holdMin);
      }
      if (this.spring) {
        const w = this.rate * 1.6, z = 0.9;
        this.vel += (w * w * (this.target - this.value) - 2 * z * w * this.vel) * dt;
        this.value += this.vel * dt;
      } else this.value = approach(this.value, this.target, this.rate, dt);
    }
    /** aim at a value and stay there: the rig picks the next one */
    aim(v) {
      this.target = v;
      this.next = Infinity;
    }
    set(amp, holdMin, holdMax, rate) {
      this.amp = amp;
      this.holdMin = holdMin;
      this.holdMax = holdMax;
      this.rate = rate;
      this.next = 0;
    }
  };
  var Event = class {
    constructor(duration) {
      this.duration = duration;
      this.p = -1;
    }
    fire() {
      this.p = 0;
    }
    get active() {
      return this.p >= 0;
    }
    update(dt) {
      if (this.p < 0) return;
      this.p += dt / this.duration;
      if (this.p >= 1) this.p = -1;
    }
  };
  var GAZE_YAW = 35 * DEG;
  var GAZE_PITCH = 14 * DEG;
  var GAZE_ROLL = 3.2 * DEG;
  var GAZE_HOLD_MIN = 2.6;
  var GAZE_HOLD_MAX = 4.4;
  var REST = {
    default: { pitch: 0, roll: 0, y: 0, lookX: 0, lookY: 0 },
    working: { pitch: 5 * DEG, roll: 0, y: 0, lookX: 0, lookY: 0 },
    sleeping: { pitch: -16 * DEG, roll: 6 * DEG, y: 3, lookX: 0, lookY: 1 }
  };
  var Sim = class {
    constructor(seed, state = "default") {
      this.pose = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, sx: 1, sy: 1, eyeOpen: 1, blinkL: 0, blinkR: 0, lookX: 0, lookY: 0, breath: 0, laugh: 0, whirl: 0, whirlAngle: 0, w: [1, 0, 0] };
      this.state = "default";
      this.t = 0;
      /* a state change: the weights it started from and its progress */
      this.wFrom = [1, 0, 0];
      this.tr = 1;
      this.trDuration = 1.2;
      this.blink = new Event(0.17);
      this.blinkAgain = false;
      /* −1 left eye only, 1 right eye only, 0 both */
      this.dart = new Event(0.12);
      this.dartX = 0;
      this.dartY = 0;
      this.flip = new Event(flipDuration(JUMP_DEFAULTS, false));
      this.flipPoked = false;
      this.jump = { ...JUMP_DEFAULTS };
      this.flipSide = 1;
      this.nod = new Event(1.7);
      this.hopPhase = 0;
      this.hopCount = 0;
      /** the hops' gain: the working weight while in the state, then held so
          a hop under way finishes whole when the state is left */
      this.hopGain = 0;
      this.laughEv = new Event(0.8);
      /* the jelly: a damped spring driven by how fast the head turns, so a
         sweep stretches the body and it wobbles back */
      this.prevYaw = 0;
      this.jelly = 0;
      this.jellyV = 0;
      /** how far the eyes run ahead of a head turn */
      this.gazeLead = 0;
      /** the idle gaze: where the head is looking, and when it moves on */
      this.gazeDir = [0, 0];
      this.gazeAt = 0;
      /** how far it turns to the side, 1 as the gaze has it */
      this.turnK = 1;
      /** the breathing cycle's phase, in turns */
      this.breathPhase = 0;
      /* the pointer, as an offset from the head in head-widths, and how much
         to follow it — both smoothed */
      this.ptrX = 0;
      this.ptrY = 0;
      this.ptrS = 0;
      this.ptrTargetX = 0;
      this.ptrTargetY = 0;
      this.ptrTargetS = 0;
      /* the smoothed yaw the head is turning to on its own */
      this.baseYaw = 0;
      this.rand = rng(Math.floor(seed * 1e6) + 1);
      const r = this.rand;
      this.yawW = new Wander(r, 36 * DEG, 1.1, 2.6, 3, true);
      this.pitchW = new Wander(r, 10 * DEG, 1.1, 2.6, 2.6, true);
      this.rollW = new Wander(r, 5 * DEG, 1.6, 3.2, 2, true);
      this.lookXW = new Wander(r, 3.6, 0.5, 2, 14);
      this.lookYW = new Wander(r, 2.4, 0.5, 2, 14);
      this.t = r() * 10;
      this.hopPhase = r();
      this.breathPhase = r();
      this.blinkAt = this.t + 1 + r() * 3;
      this.flipAt = this.nextFlip(this.t, 1);
      this.nodAt = this.t + 3 + r() * 4;
      this.dartAt = this.t + 1 + r() * 2;
      this.laughAt = this.t + 0.6 + r() * 1.5;
      this.setState(state, true);
    }
    setState(next, immediate = false) {
      if (next === this.state && !immediate) return;
      const from = this.state;
      this.state = next;
      const w = this.pose.w;
      if (immediate) {
        for (let i = 0; i < 3; i++) w[i] = STATES[i] === next ? 1 : 0;
        this.tr = 1;
      } else {
        this.wFrom = [w[0], w[1], w[2]];
        this.tr = 0;
        this.trDuration = from === "sleeping" ? SWITCH_FROM_SLEEP : SWITCH_TO[next];
      }
      switch (next) {
        case "default":
          this.yawW.set(GAZE_YAW, 2.6, 5.4, 2);
          this.pitchW.set(GAZE_PITCH, 2.8, 5.8, 1.8);
          this.rollW.set(GAZE_ROLL, 3.4, 6.6, 1.5);
          this.gazeAt = 0;
          this.gazeDir = [0, 0];
          this.lookXW.set(3.6, 0.6, 2.2, 13);
          this.lookYW.set(2.4, 0.6, 2.2, 13);
          this.flipAt = this.nextFlip(this.t, 0.6);
          break;
        case "working":
          this.yawW.set(16 * DEG, 0.9, 1.8, 4);
          this.pitchW.set(3 * DEG, 1.2, 2.4, 3);
          this.rollW.set(0, 1, 2, 3);
          this.lookXW.set(2, 0.5, 1.2, 12);
          this.lookYW.set(1, 0.5, 1.2, 12);
          this.hopPhase = 0;
          this.hopCount = 0;
          this.laughAt = this.t + 0.5 + this.rand() * 1.2;
          break;
        case "sleeping":
          this.yawW.set(7 * DEG, 3, 6, 0.7);
          this.pitchW.set(3 * DEG, 3, 6, 0.7);
          this.rollW.set(2 * DEG, 3, 6, 0.6);
          this.lookXW.set(0, 2, 4, 2);
          this.lookYW.set(0, 2, 4, 2);
          this.nodAt = this.t + 2.5 + this.rand() * 4;
          break;
      }
    }
    /** Where the pointer is, relative to the head (−1 … 1 across a head
        width), and how strongly to follow it (0 lets go). */
    setPointer(x, y, strength) {
      this.ptrTargetX = Math.max(-1.2, Math.min(1.2, x));
      this.ptrTargetY = Math.max(-1.2, Math.min(1.2, y));
      this.ptrTargetS = Math.max(0, Math.min(1, strength));
    }
    /** A hop and a full turn, right now, whatever the state. */
    poke() {
      if (this.flip.active && this.flip.p < 0.6) return;
      this.flipPoked = true;
      this.flip.duration = flipDuration(this.jump, true);
      this.flipSide = this.rand() < 0.5 ? -1 : 1;
      this.flip.fire();
      this.flipAt = this.nextFlip(this.t, 1.1);
    }
    /** How far the head turns to the side while idle: 1 as the gaze has
        it, 0 keeps it facing forward. */
    setTurn(k) {
      const next = Math.max(0, k);
      if (next === this.turnK) return;
      this.turnK = next;
      if (this.state === "default") this.gazeAt = 0;
    }
    /** The jump's numbers; any subset. */
    setJump(j) {
      const every = this.jump.every;
      Object.assign(this.jump, j);
      if (j.every !== void 0 && j.every !== every) this.flipAt = this.nextFlip(this.t, 1);
    }
    /* Where the head looks next. From a corner it mostly swings straight
       across to the opposite one — top right, stay, bottom left — now and
       then only sideways, or back to the middle for a beat. */
    nextGaze() {
      const r = this.rand;
      const [px, py] = this.gazeDir;
      if (px !== 0 || py !== 0) {
        const p = r();
        if (p < 0.66) return [-px, -py];
        if (p < 0.85) return [-px, py];
        return [0, 0];
      }
      const corners = [
        [1, -1],
        [-1, 1],
        [-1, -1],
        [1, 1]
      ];
      return corners[Math.floor(r() * corners.length)];
    }
    /** when the next idle jump is due: `every` seconds, give or take 40 % */
    nextFlip(t, k) {
      const every = this.jump.every;
      return every > 0 ? t + every * k * (0.625 + this.rand() * 0.75) : Infinity;
    }
    /** Advance by `dt` seconds (already scaled by the speed). */
    update(dt) {
      dt = Math.min(dt, 0.05);
      this.t += dt;
      const t = this.t;
      const p = this.pose;
      const w = p.w;
      if (this.tr < 1) {
        this.tr = Math.min(1, this.tr + dt / this.trDuration);
        const e = easeSine(this.tr);
        for (let i = 0; i < 3; i++) {
          const target = STATES[i] === this.state ? 1 : 0;
          w[i] = this.wFrom[i] + (target - this.wFrom[i]) * e;
        }
      }
      const [wd, ww, ws] = w;
      const rest = { pitch: 0, roll: 0, y: 0, lookX: 0, lookY: 0 };
      for (let i = 0; i < 3; i++) {
        const r = REST[STATES[i]];
        rest.pitch += r.pitch * w[i];
        rest.roll += r.roll * w[i];
        rest.y += r.y * w[i];
        rest.lookX += r.lookX * w[i];
        rest.lookY += r.lookY * w[i];
      }
      if (this.state === "default" && t >= this.gazeAt) {
        const [gx, gy] = this.nextGaze();
        this.gazeDir = [gx, gy];
        const reach = 0.84 + this.rand() * 0.16;
        this.yawW.aim(gx * GAZE_YAW * reach * this.turnK);
        this.pitchW.aim(gy * GAZE_PITCH * reach);
        this.rollW.aim(gx * GAZE_ROLL * reach * this.turnK);
        this.gazeAt = t + GAZE_HOLD_MIN + this.rand() * (GAZE_HOLD_MAX - GAZE_HOLD_MIN);
      }
      this.yawW.update(t, dt);
      this.pitchW.update(t, dt);
      this.rollW.update(t, dt);
      this.lookXW.update(t, dt);
      this.lookYW.update(t, dt);
      this.ptrS = approach(this.ptrS, this.ptrTargetS, 8, dt);
      this.ptrX = approach(this.ptrX, this.ptrTargetX, 14, dt);
      this.ptrY = approach(this.ptrY, this.ptrTargetY, 14, dt);
      const ps = this.ptrS;
      const quiet = 1 - 0.75 * ps;
      this.baseYaw = approach(this.baseYaw, this.yawW.value * quiet + 22 * DEG * this.ptrX * ps, 5, dt);
      const basePitch = rest.pitch + this.pitchW.value * quiet - 12 * DEG * this.ptrY * ps;
      const baseRoll = rest.roll + this.rollW.value * quiet;
      const baseY = rest.y;
      const baseLookX = rest.lookX + this.lookXW.value * quiet + 4.5 * this.ptrX * ps;
      const baseLookY = rest.lookY + this.lookYW.value * quiet + 3 * this.ptrY * ps;
      let spin = 0, hopY = 0, sx = 1, sy = 1, pitchAdd = 0, rollAdd = 0, blinkClose = 0, lookXAdd = 0, lookYAdd = 0, laugh = 0;
      let whirl = 0, whirlAngle = 0;
      const smooth2 = (a, b, v) => {
        const x = Math.min(1, Math.max(0, (v - a) / (b - a)));
        return x * x * (3 - 2 * x);
      };
      const envelope = (q) => smooth2(0.1, 0.26, q) * (1 - smooth2(0.66, 0.9, q));
      const ringAngle = (q) => TAU * (1.5 * q + 0.9 * easeInOut(q));
      if (t >= this.blinkAt && !this.blink.active && wd + ww > 0.5) {
        this.blink.fire();
        this.blinkAgain = !this.blinkAgain && this.rand() < 0.22;
        this.blinkAt = t + (this.blinkAgain ? 0.28 : 2.2 + this.rand() * 2.6);
      }
      this.blink.update(dt);
      if (this.blink.active) blinkClose = Math.sin(Math.PI * this.blink.p);
      if (t >= this.dartAt && !this.dart.active && wd + ww > 0.5) {
        this.dart.fire();
        this.dartX = (this.rand() * 2 - 1) * 4;
        this.dartY = (this.rand() * 2 - 1) * 2;
        this.dart.duration = 0.25 + this.rand() * 0.45;
        this.dartAt = t + 1.2 + this.rand() * 2.6;
      }
      this.dart.update(dt);
      if (this.dart.active) {
        const q = this.dart.p;
        const hold = q < 0.15 ? q / 0.15 : q > 0.8 ? (1 - q) / 0.2 : 1;
        lookXAdd += this.dartX * hold * (wd + ww);
        lookYAdd += this.dartY * hold * (wd + ww);
      }
      if (this.state === "default" && t >= this.flipAt && !this.flip.active) {
        this.flipPoked = false;
        this.flip.duration = flipDuration(this.jump, false);
        this.flipSide = this.rand() < 0.5 ? -1 : 1;
        this.flip.fire();
        this.flipAt = this.nextFlip(t, 1);
      }
      this.flip.update(dt);
      if (this.flip.active) {
        const J2 = this.jump;
        const preS = flipPre(J2, this.flipPoked);
        const a = (this.flip.p * this.flip.duration - preS) / J2.time;
        const q = Math.min(1, Math.max(0, a));
        const arc = Math.sin(Math.PI * q);
        spin += TAU * J2.spin * easeInOut(q);
        hopY -= J2.height * arc;
        const tl = (a - 1) * J2.time - J2.land;
        const squashTime = this.flipPoked ? J2.clickSquashTime : J2.squashTime;
        const crouch = (u) => this.flipPoked ? u * u * (3 - 2 * u) : hopSquash(u - 1);
        const hold = Math.max(0, J2.groundTime);
        const peakT = SQUASH_PEAK[J2.squashEase] * squashTime;
        const rise = tl - peakT - hold;
        const depth = tl <= peakT ? squashPulse(tl / squashTime, J2.squashEase) : rise <= 0 ? groundShape((tl - peakT) / hold, J2.groundEase) : risePulse(rise / J2.riseTime, J2.riseEase);
        const land = (a < 0 ? crouch(Math.max(0, 1 + a * J2.time / preS)) : tl > 0 ? depth : a < 0.2 ? hopSquash(a) : 0) * J2.squash;
        sx += 0.16 * land - 0.06 * arc * J2.stretch;
        sy += -0.18 * land + 0.09 * arc * J2.stretch;
        rollAdd += this.flipSide * J2.lean * DEG * arc;
        if (J2.spin > 0) {
          laugh = Math.max(laugh, arc);
          whirl = Math.max(whirl, envelope(q));
          whirlAngle = ringAngle(q);
        }
      }
      const J = this.jump;
      const exitHold = Math.max(0, J.groundTime);
      const exitFor = exitHold + J.riseTime;
      if (this.state === "working") this.hopGain = ww;
      if (this.hopGain > 0.02 && (this.state === "working" || this.hopPhase > 0)) {
        this.hopPhase += dt / HOP_T;
        if (this.hopPhase >= 1) {
          if (this.state === "working") {
            this.hopPhase -= 1;
            this.hopCount += 1;
          } else if ((this.hopPhase - 1) * HOP_T >= exitFor) {
            this.hopPhase = 0;
            this.hopGain = 0;
          }
        }
        const g = this.hopGain;
        const q = Math.min(1, this.hopPhase);
        const arc = Math.sin(Math.PI * q);
        const spinning = this.hopCount % 3 === 2;
        const h = spinning ? HOP_SPIN_H : 18;
        hopY -= h * arc * g;
        const exitT = this.state !== "working" && this.hopPhase > 1 ? (this.hopPhase - 1) * HOP_T : -1;
        const land = exitT < 0 ? hopSquash(this.hopPhase) : exitT < exitHold ? groundShape(exitT / exitHold, J.groundEase) : risePulse((exitT - exitHold) / J.riseTime, J.riseEase);
        sx += (0.16 * land - 0.06 * arc) * g;
        sy += (-0.18 * land + 0.09 * arc) * g;
        if (spinning) {
          spin += TAU * easeInOut(q) * g;
          laugh = Math.max(laugh, arc * g);
          if (envelope(q) * g > whirl) {
            whirl = envelope(q) * g;
            whirlAngle = ringAngle(q);
          }
        }
        rollAdd += (this.hopCount % 2 === 0 ? 1 : -1) * 6 * DEG * arc * g;
      }
      if (this.state === "working" && t >= this.laughAt && !this.laughEv.active) {
        this.laughEv.fire();
        this.laughEv.duration = 0.6 + this.rand() * 0.5;
        this.laughAt = t + 1.6 + this.rand() * 2.2;
      }
      this.laughEv.update(dt);
      if (this.laughEv.active) {
        const q = this.laughEv.p;
        laugh = Math.max(laugh, q < 0.18 ? q / 0.18 : q > 0.78 ? (1 - q) / 0.22 : 1);
      }
      if (this.state === "sleeping" && t >= this.nodAt && !this.nod.active) {
        this.nod.fire();
        this.nodAt = t + 4 + this.rand() * 4;
      }
      this.nod.update(dt);
      if (this.nod.active) {
        const q = this.nod.p;
        const dip = q < 0.72 ? easeInOut(q / 0.72) : 1 - easeInOut((q - 0.72) / 0.28);
        pitchAdd -= 13 * DEG * dip * ws;
      }
      this.breathPhase += dt / (3.6 + 1.2 * ws);
      const breath = Math.sin(this.breathPhase * TAU);
      p.breath = breath;
      sx += breath * (8e-3 + 0.014 * ws);
      sy += breath * (0.012 + 0.02 * ws);
      const bob = Math.sin(t * TAU / 3.4) * 2 * (1 - ws);
      p.yaw = this.baseYaw + spin;
      let dyaw = this.baseYaw - this.prevYaw;
      dyaw = ((dyaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
      this.prevYaw = this.baseYaw;
      const rate = dt > 0 ? Math.abs(dyaw) / dt : 0;
      const leadTarget = dt > 0 ? Math.max(-2.2, Math.min(2.2, dyaw / dt * 2.4)) : 0;
      this.gazeLead = approach(this.gazeLead, leadTarget, 9, dt);
      const jellyTarget = Math.min(0.22, 0.055 * rate);
      const omega = 16, zeta = 0.45;
      this.jellyV += (omega * omega * (jellyTarget - this.jelly) - 2 * zeta * omega * this.jellyV) * dt;
      this.jelly += this.jellyV * dt;
      const jelly = Math.max(-0.08, Math.min(0.28, this.jelly)) * 0.6;
      sx *= 1 + jelly;
      sy *= 1 - 0.55 * jelly;
      p.pitch = basePitch + pitchAdd;
      p.roll = baseRoll + rollAdd;
      p.x = 0;
      p.y = baseY + hopY + bob;
      p.sx = sx;
      p.sy = sy;
      p.eyeOpen = 1;
      p.laugh = approach(p.laugh, laugh, 30, dt);
      p.blinkL = blinkClose;
      p.blinkR = blinkClose;
      p.lookX = baseLookX + lookXAdd + this.gazeLead;
      p.lookY = baseLookY + lookYAdd;
      p.whirl = whirl;
      p.whirlAngle = whirlAngle;
    }
  };
  function restPose(state) {
    const r = REST[state];
    return {
      yaw: 0,
      pitch: r.pitch,
      roll: r.roll,
      x: 0,
      y: r.y,
      sx: 1,
      sy: 1,
      eyeOpen: 1,
      blinkL: 0,
      blinkR: 0,
      lookX: r.lookX,
      lookY: r.lookY,
      breath: 0,
      laugh: 0,
      whirl: 0,
      whirlAngle: 0,
      w: STATES.map((s) => s === state ? 1 : 0)
    };
  }

  // src/plastic.ts
  var PAD = 3;
  var SPAN = 100 + 2 * PAD;
  var M = 64;
  var MM = M * M;
  var CONIC_STOPS = 24;
  var INF = 1e12;
  var EL = 48 * Math.PI / 180;
  var E_XY = Math.cos(EL);
  var E_Z = Math.sin(EL);
  var SLICES = 17;
  var profile = (z, cap) => cap + (1 - cap) * Math.sqrt(Math.max(0, 1 - z * z));
  function edt1d(f, n, d, s, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -1e30;
    z[1] = 1e30;
    for (let q = 1; q < n; q++) {
      let x = 0;
      for (; ; ) {
        const vk = v[k];
        x = (f[q] + q * q - f[vk] - vk * vk) / (2 * (q - vk));
        if (x > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = x;
      z[k + 1] = 1e30;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const vk = v[k];
      d[q] = (q - vk) * (q - vk) + f[vk];
      s[q] = vk;
    }
  }
  function edt2d(mask, site, N, out, near) {
    const f = new Float32Array(N), d = new Float32Array(N), s = new Int32Array(N), v = new Int32Array(N), z = new Float32Array(N + 1);
    const g = new Float32Array(N * N), row = new Int32Array(N * N);
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) f[y] = mask[y * N + x] === site ? 0 : INF;
      edt1d(f, N, d, s, v, z);
      for (let y = 0; y < N; y++) {
        g[y * N + x] = d[y];
        row[y * N + x] = s[y];
      }
    }
    for (let y = 0; y < N; y++) {
      const o = y * N;
      for (let x = 0; x < N; x++) f[x] = g[o + x];
      edt1d(f, N, d, s, v, z);
      for (let x = 0; x < N; x++) {
        out[o + x] = d[x];
        if (near) near[o + x] = row[o + s[x]] * N + s[x];
      }
    }
  }
  function blur5(a, N, tmp) {
    for (let y = 0; y < N; y++) {
      const o = y * N;
      for (let x = 0; x < N; x++) {
        const x0 = x < 2 ? 0 : x - 2, x1 = x < 1 ? 0 : x - 1, x3 = x > N - 2 ? N - 1 : x + 1, x4 = x > N - 3 ? N - 1 : x + 2;
        tmp[o + x] = (a[o + x0] + 4 * a[o + x1] + 6 * a[o + x] + 4 * a[o + x3] + a[o + x4]) * 0.0625;
      }
    }
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        const y0 = y < 2 ? 0 : y - 2, y1 = y < 1 ? 0 : y - 1, y3 = y > N - 2 ? N - 1 : y + 1, y4 = y > N - 3 ? N - 1 : y + 2;
        a[y * N + x] = (tmp[y0 * N + x] + 4 * tmp[y1 * N + x] + 6 * tmp[y * N + x] + 4 * tmp[y3 * N + x] + tmp[y4 * N + x]) * 0.0625;
      }
    }
  }
  function poisson(cov, N, u) {
    const levels = [];
    for (let n = N, f = 1; f <= 4 && n % 2 === 0 || f === 1; n >>= 1, f <<= 1) {
      const mask = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let sum = 0;
          for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) sum += cov[(y * f + j) * N + x * f + i];
          mask[y * n + x] = sum >= 128 * f * f ? 1 : 0;
        }
      }
      levels.push({ n, mask, phi: new Float32Array(n * n) });
      if (f === 4) break;
    }
    const sweep = (L, s, iters, om) => {
      const { n, mask, phi } = L, s2 = s * s;
      for (let it = 0; it < iters; it++) {
        for (let y = 1; y < n - 1; y++) {
          const o = y * n;
          for (let x = 1; x < n - 1; x++) {
            const i = o + x;
            if (!mask[i]) continue;
            const v = (phi[i - 1] + phi[i + 1] + phi[i - n] + phi[i + n] + s2) * 0.25;
            phi[i] += om * (v - phi[i]);
          }
        }
      }
    };
    for (let l = levels.length - 1; l >= 0; l--) {
      const L = levels[l], f = 1 << l;
      if (l < levels.length - 1) {
        const C = levels[l + 1], n = L.n, cn = C.n;
        for (let y = 0; y < n; y++) {
          const fy = Math.min(cn - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = fy | 0, y1 = Math.min(cn - 1, y0 + 1), ty = fy - y0;
          for (let x = 0; x < n; x++) {
            const i = y * n + x;
            if (!L.mask[i]) continue;
            const fx = Math.min(cn - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = fx | 0, x1 = Math.min(cn - 1, x0 + 1), tx = fx - x0;
            L.phi[i] = (C.phi[y0 * cn + x0] * (1 - tx) + C.phi[y0 * cn + x1] * tx) * (1 - ty) + (C.phi[y1 * cn + x0] * (1 - tx) + C.phi[y1 * cn + x1] * tx) * ty;
          }
        }
      }
      const om = Math.min(1.9, 2 / (1 + Math.sin(Math.PI / L.n)) - 0.05);
      sweep(L, u * f, 4, 1);
      sweep(L, u * f, l === 2 ? 100 : l === 1 ? 30 : 16, om);
      sweep(L, u * f, 8, 1);
    }
    return levels[0].phi;
  }
  var DX = [1, 1, 0, -1, -1, -1, 0, 1];
  var DY = [0, 1, 1, 1, 0, -1, -1, -1];
  var DL = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];
  function buildForm(cov, N, halfDepth) {
    const u = SPAN / N, NN = N * N;
    const mask = new Uint8Array(NN);
    for (let i = 0; i < NN; i++) mask[i] = cov[i] >= 128 ? 1 : 0;
    const dIn = new Float32Array(NN), dOut = new Float32Array(NN), nearIn = new Int32Array(NN);
    edt2d(mask, 0, N, dIn, null);
    edt2d(mask, 1, N, dOut, nearIn);
    const sd = new Float32Array(NN), tmp = new Float32Array(NN);
    for (let i = 0; i < NN; i++) {
      const a = cov[i] / 255;
      sd[i] = u * (a > 0 && a < 1 ? a - 0.5 : mask[i] ? Math.sqrt(dIn[i]) - 0.5 : 0.5 - Math.sqrt(dOut[i]));
    }
    blur5(sd, N, tmp);
    blur5(sd, N, tmp);
    const phi = poisson(cov, N, u);
    let phiMax = 0;
    for (let i = 0; i < NN; i++) if (phi[i] > phiMax) phiMax = phi[i];
    const rIn = 2 * Math.sqrt(phiMax);
    const hMax = Math.min(0.9 * halfDepth + 0.12 * rIn, 1.2 * rIn);
    const kh = phiMax > 0 ? hMax / Math.sqrt(phiMax) : 0;
    const h = new Float32Array(NN);
    for (let i = 0; i < NN; i++) h[i] = phi[i] > 0 ? kh * Math.sqrt(phi[i]) : 0;
    blur5(h, N, tmp);
    const form = { N, i00: new Uint16Array(NN), wx: new Uint8Array(NN), wy: new Uint8Array(NN), ao: new Uint8Array(NN) };
    const { i00, wx, wy, ao } = form;
    const STEPS = N <= 64 ? [1, 2, 3, 5, 8] : N <= 96 ? [1, 2, 4, 7, 11] : [1, 2, 4, 7, 11, 15];
    const halo = 9;
    const last2 = N - 1;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        const src = mask[i] ? i : dOut[i] <= halo ? nearIn[i] : -1;
        if (src < 0) continue;
        const sx = src % N, sy = (src - sx) / N;
        const xl = sx > 0 ? sx - 1 : 0, xr = sx < last2 ? sx + 1 : last2, yu = sy > 0 ? sy - 1 : 0, yd = sy < last2 ? sy + 1 : last2;
        let nx = -(h[sy * N + xr] - h[sy * N + xl]) / (2 * u);
        let ny = -(h[yd * N + sx] - h[yu * N + sx]) / (2 * u);
        let nz = 1;
        let len = Math.sqrt(nx * nx + ny * ny + 1);
        nx /= len;
        ny /= len;
        nz /= len;
        const dd = Math.max(0, sd[src]);
        if (dd < 2) {
          let gx = sd[sy * N + xr] - sd[sy * N + xl], gy = sd[yd * N + sx] - sd[yu * N + sx];
          const gl = Math.hypot(gx, gy) || 1;
          gx /= gl;
          gy /= gl;
          const w = 0.7 * (1 - dd / 2);
          nx += w * (-gx - nx);
          ny += w * (-gy - ny);
          nz += w * (0 - nz);
          len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len;
          ny /= len;
          nz /= len;
        }
        const h0 = h[src];
        let occ = 0;
        for (let d = 0; d < 8; d++) {
          let m = 0;
          for (let k = 0; k < STEPS.length; k++) {
            const r = STEPS[k];
            let qx = sx + DX[d] * r, qy = sy + DY[d] * r;
            if (qx < 0) qx = 0;
            else if (qx > last2) qx = last2;
            if (qy < 0) qy = 0;
            else if (qy > last2) qy = last2;
            const t = (h[qy * N + qx] - h0) / (r * u * DL[d]);
            if (t > m) m = t;
          }
          occ += m / Math.sqrt(1 + m * m);
        }
        const e = 1 - Math.min(1, dd / 3);
        const edge = 1 - 0.2 * e * e;
        const aoLin = Math.pow(1 - 0.9 * occ / 8, 1.5) * edge;
        ao[i] = Math.max(1, Math.round(255 * Math.pow(aoLin, 1 / 2.2)));
        const fx = (nx * 0.5 + 0.5) * (M - 1), fy = (ny * 0.5 + 0.5) * (M - 1);
        const cx = Math.min(M - 2, Math.max(0, fx | 0)), cy = Math.min(M - 2, Math.max(0, fy | 0));
        i00[i] = cy * M + cx;
        wx[i] = Math.round(255 * Math.min(1, Math.max(0, fx - cx)));
        wy[i] = Math.round(255 * Math.min(1, Math.max(0, fy - cy)));
      }
    }
    return form;
  }
  function makeCanvas(n) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(n, n);
    if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = c.height = n;
      return c;
    }
    return null;
  }
  function ctx2d(c, readBack) {
    return c.getContext("2d", readBack ? { willReadFrequently: true } : void 0);
  }
  function rasterize(path, N) {
    const c = makeCanvas(N);
    const g = c && ctx2d(c, true);
    if (!g) return null;
    const u = SPAN / N;
    g.setTransform(1 / u, 0, 0, 1 / u, PAD / u, PAD / u);
    g.fillStyle = "#fff";
    g.fill(path);
    const px = g.getImageData(0, 0, N, N).data;
    const cov = new Uint8ClampedArray(N * N);
    for (let i = 0; i < N * N; i++) cov[i] = px[i * 4 + 3];
    return cov;
  }
  var forms = /* @__PURE__ */ new Map();
  var pending = /* @__PURE__ */ new Set();
  var pathIds = /* @__PURE__ */ new WeakMap();
  var nextPathId = 0;
  function pathId(p) {
    let id = pathIds.get(p);
    if (!id) pathIds.set(p, id = `p${nextPathId++}`);
    return id;
  }
  var queue = [];
  var scheduled = false;
  function pump() {
    scheduled = false;
    const fn = queue.shift();
    if (fn) fn();
    if (queue.length) schedule();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    const ric = globalThis.requestIdleCallback;
    if (ric) ric(pump, { timeout: 120 });
    else setTimeout(pump, 16);
  }
  function idle(fn) {
    queue.push(fn);
    schedule();
  }
  function formFor(key, path, N, halfDepth, sync) {
    var _a;
    const id = `${key}|${N}|${Math.round(halfDepth)}`;
    const hit = forms.get(id);
    if (hit) return hit;
    const build = () => {
      pending.delete(id);
      if (forms.has(id)) return;
      const cov = rasterize(path, N);
      if (!cov) return;
      if (forms.size >= 48) forms.clear();
      forms.set(id, buildForm(cov, N, halfDepth));
    };
    if (sync) {
      build();
      return (_a = forms.get(id)) != null ? _a : null;
    }
    if (!pending.has(id)) {
      pending.add(id);
      idle(build);
    }
    return null;
  }
  function warmPlastic(key, path, devicePx = 192, depth = 0.65) {
    formFor(key, path, tierFor(devicePx), 15 * depth, true);
  }
  function tierFor(devicePx) {
    return devicePx <= 100 ? 64 : devicePx <= 224 ? 96 : 128;
  }
  var toLin = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  var linCache = /* @__PURE__ */ new Map();
  function linearColor(color) {
    let c = linCache.get(color);
    if (!c) {
      let rgb = parseColor(color);
      if (!rgb) {
        const cv = makeCanvas(1);
        const g = cv && ctx2d(cv, true);
        if (g) {
          g.fillStyle = color;
          g.fillRect(0, 0, 1, 1);
          const p = g.getImageData(0, 0, 1, 1).data;
          rgb = [p[0], p[1], p[2]];
        } else rgb = [128, 128, 128];
      }
      c = [toLin(rgb[0] / 255), toLin(rgb[1] / 255), toLin(rgb[2] / 255)];
      if (linCache.size > 200) linCache.clear();
      linCache.set(color, c);
    }
    return c;
  }
  var TONE_N = 2048;
  var TONE_MAX = 2.5;
  var TONE_SCALE = TONE_N / TONE_MAX;
  var toneLut = new Float32Array(TONE_N);
  for (let i = 0; i < TONE_N; i++) {
    const v = (i + 0.5) / TONE_SCALE;
    const y = v <= 0.75 ? v : 0.75 + 0.25 * (1 - Math.exp(-(v - 0.75) / 0.25));
    toneLut[i] = 255 * (y <= 31308e-7 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
  }
  var tone = (v) => toneLut[v <= 0 ? 0 : v >= TONE_MAX ? TONE_N - 1 : v * TONE_SCALE | 0];
  var POW_N = 1024;
  var powLuts = /* @__PURE__ */ new Map();
  function powLut(e) {
    let t = powLuts.get(e);
    if (!t) {
      t = new Float32Array(POW_N + 1);
      for (let i = 0; i <= POW_N; i++) t[i] = Math.pow(i / POW_N, e);
      if (powLuts.size > 16) powLuts.clear();
      powLuts.set(e, t);
    }
    return t;
  }
  var ENV = [0.92, 0.96, 1];
  var WARM = [1, 0.98, 0.95];
  var smooth = (a, b, v) => {
    const t = v <= a ? 0 : v >= b ? 1 : (v - a) / (b - a);
    return t * t * (3 - 2 * t);
  };
  var soft = (w, s, x) => 1 - smooth(w - s, w + s, x);
  function buildMatcap(out, c, f, p) {
    const { L, V, H, U, W, A, B } = f;
    const mx = Math.max(c[0], c[1], c[2], 0.05);
    const tint = [c[0] / mx, c[1] / mx, c[2] / mx];
    const amb = Math.max(0.03, 0.3 - 0.15 * p.shadow);
    const wrap = 0.15 + 0.14 * p.spread;
    const kd = 0.85;
    const e1 = Math.min(90, Math.round(110 / Math.pow(p.spread, 1.3))), e2 = Math.max(2, Math.round(8 / p.spread));
    const lut1 = powLut(e1), lut2 = powLut(e2);
    const ks1 = 0.45 * p.highlight, ks2 = 0.1 * p.highlight, winK = 0.11 * p.highlight, rimK = 0.3 * p.rim;
    const ambT = [amb * tint[0], amb * tint[1], amb * tint[2]];
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        let nx = i / (M - 1) * 2 - 1, ny = j / (M - 1) * 2 - 1;
        let r2 = nx * nx + ny * ny;
        if (r2 > 1.14) continue;
        if (r2 > 1) {
          const s = 1 / Math.sqrt(r2);
          nx *= s;
          ny *= s;
          r2 = 1;
        }
        const nz = Math.sqrt(1 - r2);
        const nl = nx * L[0] + ny * L[1] + nz * L[2];
        const nv = Math.max(0, nx * V[0] + ny * V[1] + nz * V[2]);
        const nh = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]);
        const dif = Math.min(1, Math.max(0, (nl + wrap) / (1 + wrap)));
        const q = 1 - nv, q2 = q * q, f3 = q2 * q, f5 = f3 * q2;
        const ni = nh * POW_N | 0;
        const spec = (ks1 * lut1[ni] + ks2 * lut2[ni]) * (1 + 3 * f5);
        const rx = 2 * nv * nx - V[0], ry = 2 * nv * ny - V[1], rz = 2 * nv * nz - V[2];
        const sky = 0.45 + 0.55 * smooth(-0.4, 0.6, rx * U[0] + ry * U[1] + rz * U[2]);
        const rw = rx * W[0] + ry * W[1] + rz * W[2];
        let win = 0;
        if (rw > 0.5) {
          const ra = (rx * A[0] + ry * A[1] + rz * A[2]) / rw, rb = (rx * B[0] + ry * B[1] + rz * B[2]) / rw;
          win = soft(0.34, 0.12, Math.abs(ra)) * soft(0.12, 0.06, Math.abs(rb));
        }
        const env = rimK * f3 * sky + winK * win;
        const k = (j * M + i) * 3;
        out[k] = tone(c[0] * (ambT[0] + kd * dif) + spec * WARM[0] + env * ENV[0]);
        out[k + 1] = tone(c[1] * (ambT[1] + kd * dif) + spec * WARM[1] + env * ENV[1]);
        out[k + 2] = tone(c[2] * (ambT[2] + kd * dif) + spec * WARM[2] + env * ENV[2]);
      }
    }
  }
  function sampleMatcap(mc, nx, ny, out) {
    const fx = (nx * 0.5 + 0.5) * (M - 1), fy = (ny * 0.5 + 0.5) * (M - 1);
    const cx = Math.min(M - 2, Math.max(0, fx | 0)), cy = Math.min(M - 2, Math.max(0, fy | 0));
    const x = fx - cx, y = fy - cy, b = (cy * M + cx) * 3, R = M * 3;
    const w00 = (1 - x) * (1 - y), w10 = x * (1 - y), w01 = (1 - x) * y, w11 = x * y;
    for (let ch = 0; ch < 3; ch++) out[ch] = mc[b + ch] * w00 + mc[b + 3 + ch] * w10 + mc[b + R + ch] * w01 + mc[b + R + 3 + ch] * w11;
  }
  function shadeTexels(form, mc, px, aoMul) {
    const { N, i00, wx, wy, ao } = form;
    const R = M * 3;
    for (let i = 0, k = 0; i < N * N; i++, k += 4) {
      const a = ao[i];
      if (a === 0) {
        px[k + 3] = 0;
        continue;
      }
      const m = aoMul[a];
      const b = i00[i] * 3, x = wx[i] * (1 / 255), y = wy[i] * (1 / 255);
      const w00 = (1 - x) * (1 - y) * m, w10 = x * (1 - y) * m, w01 = (1 - x) * y * m, w11 = x * y * m;
      px[k] = mc[b] * w00 + mc[b + 3] * w10 + mc[b + R] * w01 + mc[b + R + 3] * w11;
      px[k + 1] = mc[b + 1] * w00 + mc[b + 4] * w10 + mc[b + R + 1] * w01 + mc[b + R + 4] * w11;
      px[k + 2] = mc[b + 2] * w00 + mc[b + 5] * w10 + mc[b + R + 2] * w01 + mc[b + R + 5] * w11;
      px[k + 3] = 255;
    }
  }
  var norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  function capFrame(r) {
    const cr = Math.cos(r.roll), sr = Math.sin(r.roll);
    const lx = cr * r.lx + sr * r.ly, ly = -sr * r.lx + cr * r.ly;
    const mirror = r.facing < 0 ? -1 : 1;
    const zf = mirror * Math.min(1, Math.abs(r.facing) / 0.16);
    const { cy, sy, cp, sp } = r;
    const local = (x, y, z, zk = zf) => norm3([cy * x + sy * sp * y - sy * cp * z, cp * y + sp * z, zk * (sy * x - cy * sp * y + cy * cp * z)]);
    const L = local(E_XY * lx, E_XY * ly, E_Z);
    const V = local(0, 0, 1, mirror);
    const H = norm3([L[0] + V[0], L[1] + V[1], L[2] + V[2]]);
    const U = local(lx, ly, 0, mirror);
    const cw = Math.cos(80 * Math.PI / 180), sw = Math.sin(80 * Math.PI / 180);
    const wx = cw * lx - sw * ly, wy = sw * lx + cw * ly;
    const Ws = norm3([0.55 * wx, 0.55 * wy, 0.83]);
    const As = norm3([Ws[1], -Ws[0], 0]);
    const Bs = [Ws[1] * As[2] - Ws[2] * As[1], Ws[2] * As[0] - Ws[0] * As[2], Ws[0] * As[1] - Ws[1] * As[0]];
    const W = local(Ws[0], Ws[1], Ws[2], mirror), A = local(As[0], As[1], As[2], mirror), B = local(Bs[0], Bs[1], Bs[2], mirror);
    return { L, V, H, U, W, A, B };
  }
  var states = /* @__PURE__ */ new WeakMap();
  function stateFor(ctx, outline) {
    var _a;
    const key = (_a = ctx.canvas) != null ? _a : ctx;
    let byOutline = states.get(key);
    if (!byOutline) {
      byOutline = /* @__PURE__ */ new Map();
      states.set(key, byOutline);
    }
    let s = byOutline.get(outline);
    if (!s) {
      s = {
        N: 0,
        img: null,
        mc: new Float32Array(MM * 3),
        mcPrev: new Float32Array(MM * 3),
        mcMix: new Float32Array(MM * 3),
        mixVersion: 0,
        blendT: 1,
        blendFrames: 1,
        sinceBuild: 0,
        L: null,
        V: null,
        lx: NaN,
        ly: NaN,
        base: "",
        shadow: NaN,
        highlight: NaN,
        spread: NaN,
        rim: NaN,
        version: 0,
        imgVersion: -1,
        imgAoK: NaN,
        imgForm: null,
        aoK: -1,
        aoMul: new Float32Array(256),
        near: null,
        rimG: null,
        far: null,
        scratch: [null, null],
        scratchIdx: 0,
        scratchN: 0,
        scratchStale: true,
        sprites: [null, null, null],
        spriteVersion: -1,
        spritePx: 0
      };
      if (byOutline.size > 4) byOutline.clear();
      byOutline.set(outline, s);
    }
    return s;
  }
  var BIN = 1 / 48;
  var moved = (a, b) => !b || Math.abs(a[0] - b[0]) >= BIN || Math.abs(a[1] - b[1]) >= BIN || Math.abs(a[2] - b[2]) >= BIN;
  function mulAffine(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1],
      A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3],
      A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4],
      A[1] * B[4] + A[3] * B[5] + A[5]
    ];
  }
  function sideGradient(ctx, mc, nz, dark, lxy) {
    const rr = Math.sqrt(1 - nz * nz), c = [0, 0, 0], k = 1 - dark;
    if (typeof ctx.createConicGradient === "function") {
      const g2 = ctx.createConicGradient(0, 50, 50);
      for (let s = 0; s <= CONIC_STOPS; s++) {
        const phi = s / CONIC_STOPS * Math.PI * 2;
        sampleMatcap(mc, rr * Math.cos(phi), rr * Math.sin(phi), c);
        g2.addColorStop(s / CONIC_STOPS, `rgb(${c[0] * k | 0} ${c[1] * k | 0} ${c[2] * k | 0})`);
      }
      return g2;
    }
    const g = ctx.createLinearGradient(50 + lxy[0] * 50, 50 + lxy[1] * 50, 50 - lxy[0] * 50, 50 - lxy[1] * 50);
    const at = (nx, ny, t) => {
      sampleMatcap(mc, nx, ny, c);
      g.addColorStop(t, `rgb(${c[0] * k | 0} ${c[1] * k | 0} ${c[2] * k | 0})`);
    };
    at(rr * lxy[0], rr * lxy[1], 0);
    at(-rr * lxy[1], rr * lxy[0], 0.5);
    at(-rr * lxy[0], -rr * lxy[1], 1);
    return g;
  }
  var WEBKIT = typeof navigator !== "undefined" && /AppleWebKit\//.test(navigator.userAgent) && !/Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
  var SIDE_KINDS = [[0.55, () => 0], [0, () => 0], [0, (m) => Math.min(0.6, 0.25 * m.shadow)]];
  function drawPlasticCap(ctx, cfg, rig, pal, union, mat) {
    var _a, _b;
    const N = tierFor(rig.dev);
    const form = formFor((_a = cfg.typeKey) != null ? _a : pathId(cfg.path), cfg.path, N, rig.halfDepth, !!rig.still);
    if (!form) return false;
    const st = stateFor(ctx, (_b = cfg.typeKey) != null ? _b : pathId(cfg.path));
    const f = capFrame(rig);
    const lxy = (() => {
      const l = Math.hypot(f.L[0], f.L[1]);
      return l < 0.05 ? [0, -1] : [f.L[0] / l, f.L[1] / l];
    })();
    if (moved(f.L, st.L) || moved(f.V, st.V) || rig.lx !== st.lx || rig.ly !== st.ly || pal.base !== st.base || mat.shadow !== st.shadow || mat.highlight !== st.highlight || mat.spread !== st.spread || mat.rim !== st.rim) {
      if (st.version > 0) st.mcPrev.set(st.mcMix);
      buildMatcap(st.mc, linearColor(pal.base), f, mat);
      if (st.version === 0) {
        st.mcMix.set(st.mc);
        st.blendT = 1;
      } else {
        st.blendFrames = Math.min(10, Math.max(1, st.sinceBuild));
        st.blendT = 0;
      }
      st.sinceBuild = 0;
      st.mixVersion++;
      st.L = f.L;
      st.V = f.V;
      st.lx = rig.lx;
      st.ly = rig.ly;
      st.base = pal.base;
      st.shadow = mat.shadow;
      st.highlight = mat.highlight;
      st.spread = mat.spread;
      st.rim = mat.rim;
      st.version++;
      st.near = st.rimG = st.far = null;
    }
    st.sinceBuild++;
    if (st.blendT < 1) {
      st.blendT = Math.min(1, st.blendT + 1 / st.blendFrames);
      const e = st.blendT >= 1 ? 1 : st.blendT * st.blendT * (3 - 2 * st.blendT);
      const a2 = st.mcPrev, b2 = st.mc, o = st.mcMix;
      for (let i = 0; i < MM * 3; i++) o[i] = a2[i] + (b2[i] - a2[i]) * e;
      st.mixVersion++;
    }
    const aoK = Math.min(1.3, 1.2 * mat.shadow);
    if (aoK !== st.aoK) {
      for (let a2 = 0; a2 < 256; a2++) st.aoMul[a2] = Math.max(0, 1 - aoK * (1 - a2 / 255));
      st.aoK = aoK;
    }
    if (!st.img || st.N !== N) {
      st.img = new ImageData(N, N);
      st.N = N;
      st.imgVersion = -1;
    }
    if (st.imgVersion !== st.mixVersion || st.imgAoK !== aoK || st.imgForm !== form) {
      shadeTexels(form, st.mcMix, st.img.data, st.aoMul);
      st.imgVersion = st.mixVersion;
      st.imgAoK = aoK;
      st.imgForm = form;
      st.scratchStale = true;
    }
    if (st.scratchN !== N) {
      st.scratch = [null, null];
      st.scratchN = N;
      st.scratchStale = true;
    }
    if (st.scratchStale) {
      st.scratchIdx ^= 1;
      let sc2 = st.scratch[st.scratchIdx];
      if (!sc2) {
        const c = makeCanvas(N);
        const g = c && ctx2d(c, false);
        if (!c || !g) return false;
        sc2 = st.scratch[st.scratchIdx] = { c, g };
      }
      sc2.g.putImageData(st.img, 0, 0);
      st.scratchStale = false;
    }
    const sc = st.scratch[st.scratchIdx];
    let fast = cfg.sides === "sprite" || cfg.sides !== "vector" && WEBKIT;
    if (fast) {
      const px = Math.ceil(SPAN * rig.dev / 100);
      if (st.spritePx !== px) {
        st.sprites = [null, null, null];
        st.spritePx = px;
        st.spriteVersion = -1;
      }
      if (st.spriteVersion !== st.version) {
        const k = px / SPAN;
        for (let i = 0; i < 3 && fast; i++) {
          let spr = st.sprites[i];
          if (!spr) {
            const c = makeCanvas(px);
            const g = c && ctx2d(c, false);
            if (!c || !g) {
              fast = false;
              break;
            }
            spr = st.sprites[i] = { c, g };
          }
          spr.g.setTransform(1, 0, 0, 1, 0, 0);
          spr.g.clearRect(0, 0, px, px);
          spr.g.setTransform(k, 0, 0, k, PAD * k, PAD * k);
          spr.g.fillStyle = sideGradient(spr.g, st.mc, SIDE_KINDS[i][0], SIDE_KINDS[i][1](mat), lxy);
          spr.g.fill(cfg.path);
        }
        if (fast) st.spriteVersion = st.version;
      }
    }
    if (!fast && !st.near) {
      st.near = sideGradient(ctx, st.mc, 0.55, 0, lxy);
      st.rimG = sideGradient(ctx, st.mc, 0, 0, lxy);
      st.far = sideGradient(ctx, st.mc, 0, Math.min(0.6, 0.25 * mat.shadow), lxy);
    }
    const { cy, sy, cp, sp, halfDepth, cap } = rig;
    const order = rig.facing >= 0 ? 1 : -1;
    const [ca, cb, cc, cd, ce, cf] = rig.ctm;
    let fill = null;
    if (fast) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    let pa = 1, pb = 0, pc = 0, pd = 1, pe = 0, pf = 0;
    for (let j = 0; j < SLICES - 1; j++) {
      const k = order > 0 ? j : SLICES - 1 - j;
      const z = -1 + 2 * k / (SLICES - 1);
      const s = profile(z, cap);
      const zn = z * order;
      const m0 = cy * s, m1 = sy * sp * s, m3 = cp * s;
      const e = z * sy * halfDepth - 50 * m0, fo = -z * cy * sp * halfDepth - 50 * m1 - 50 * m3;
      const det = pa * pd - pb * pc;
      const ia = pd / det, ib = -pb / det, ic = -pc / det, id = pa / det, ie = (pc * pf - pd * pe) / det, jf = (pb * pe - pa * pf) / det;
      ctx.transform(ia * m0 + ic * m1, ib * m0 + id * m1, ic * m3, id * m3, ia * e + ic * fo + ie, ib * e + id * fo + jf);
      pa = m0;
      pb = m1;
      pc = 0;
      pd = m3;
      pe = e;
      pf = fo;
      const kind = zn > 0.4 ? 0 : zn >= 0 ? 1 : 2;
      if (fast) {
        ctx.drawImage(st.sprites[kind].c, -PAD, -PAD, SPAN, SPAN);
      } else {
        const g = kind === 0 ? st.near : kind === 1 ? st.rimG : st.far;
        if (g !== fill) ctx.fillStyle = fill = g;
        ctx.fill(cfg.path);
      }
    }
    ctx.setTransform(ca, cb, cc, cd, ce, cf);
    const inv = 1 / (cy * cp);
    const dx = sy * halfDepth / cy, dy = -sp * halfDepth * inv;
    const dl = Math.hypot(dx, dy);
    const ex = dl > 1e-6 ? order * dx / dl : 1, ey = dl > 1e-6 ? order * dy / dl : 0;
    const lead = 50 * cap + Math.hypot(50 * (1 - cap), dl);
    const stretch = (lead + 50) / 100, shift = (lead - 50) / 2;
    const a = 1 + (stretch - 1) * ex * ex, b = (stretch - 1) * ex * ey, d = 1 + (stretch - 1) * ey * ey;
    const capM = mulAffine(mulAffine(rig.ctm, [cy, sy * sp, 0, cp, 0, 0]), [a, b, b, d, shift * ex - 50 * a - 50 * b, shift * ey - 50 * b - 50 * d]);
    ctx.save();
    ctx.setTransform(capM[0], capM[1], capM[2], capM[3], capM[4], capM[5]);
    ctx.clip(cfg.path);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sc.c, -PAD, -PAD, SPAN, SPAN);
    ctx.restore();
    if (rig.dev >= 256 && mat.rim > 0 && mat.highlight > 0) {
      ctx.save();
      if (union) ctx.clip(union);
      else ctx.globalCompositeOperation = "source-atop";
      ctx.setTransform(capM[0], capM[1], capM[2], capM[3], capM[4], capM[5]);
      const al = Math.min(0.5, 0.3 * mat.rim * Math.min(1.4, mat.highlight));
      const g = ctx.createLinearGradient(50 + lxy[0] * 50, 50 + lxy[1] * 50, 50 - lxy[0] * 50, 50 - lxy[1] * 50);
      g.addColorStop(0, `rgba(235,244,255,${al.toFixed(3)})`);
      g.addColorStop(0.45, `rgba(235,244,255,${(0.35 * al).toFixed(3)})`);
      g.addColorStop(0.75, "rgba(235,244,255,0)");
      ctx.strokeStyle = g;
      ctx.lineJoin = "round";
      ctx.lineWidth = 1.3;
      ctx.stroke(cfg.path);
      ctx.restore();
    }
    return true;
  }

  // src/draw.ts
  var OVERSCAN = 1.5;
  var RISE = 0.1;
  var SLICES2 = 17;
  var HALF_DEPTH = 15;
  var CAP = 0.9;
  var profile2 = (z, cap) => cap + (1 - cap) * Math.sqrt(Math.max(0, 1 - z * z));
  var EYE_GAP = 25;
  var EYE_RX = 6.3;
  var EYE_Y = { eyes: 1, mouth: -3.5 };
  var paletteCache = /* @__PURE__ */ new Map();
  function palette(color, shadow, highlight) {
    const key = `${color}|${shadow}|${highlight}`;
    let p = paletteCache.get(key);
    if (!p) {
      const far = shade(color, -0.3 * shadow, 0.05 * shadow);
      const near = shade(color, -0.12 * shadow, 0.03 * shadow);
      const crispMix = [], smoothMix = [];
      for (let j = 0; j < SLICES2; j++) {
        const t = j / (SLICES2 - 1);
        crispMix.push(t > 0.6 ? "" : mixCss(far, near, t / 0.6));
        smoothMix.push(t >= 0.5 ? color : mixCss(far, color, t / 0.5));
      }
      p = {
        base: color,
        far,
        near,
        light: shade(color, 0.04 * highlight),
        dark: shade(color, -0.3 * shadow, 0.05 * shadow),
        capTop: shade(color, 0.035 * highlight),
        capBottom: shade(color, -0.035 * shadow),
        crispMix,
        smoothMix,
        grad: null
      };
      if (paletteCache.size > 200) paletteCache.clear();
      paletteCache.set(key, p);
    }
    return p;
  }
  var hslNums = (c) => (c.startsWith("hsl(") ? c : shade(c, 0)).match(/[\d.]+/g).map(Number);
  function mixCss(a, b, t) {
    const pa = hslNums(a);
    const pb = hslNums(b);
    const m = pa.map((v, i) => v + (pb[i] - v) * t);
    return `hsl(${m[0].toFixed(1)} ${m[1].toFixed(1)}% ${m[2].toFixed(1)}%)`;
  }
  var WHIRL_SEGMENTS = 34;
  var WHIRL_SPAN = Math.PI * 1.55;
  var WHIRL_RX = 57;
  var WHIRL_RATIO = 0.4;
  var WHIRL_TILT = -0.28;
  var whirlInkCache = /* @__PURE__ */ new Map();
  function whirlInk(color) {
    let w = whirlInkCache.get(color);
    if (!w) {
      w = { base: shade(color, 0.1, 0.02), light: shade(color, 0.3, 0.04), dark: shade(color, -0.22, 0.08), halo: shade(color, 0.2) };
      if (whirlInkCache.size > 200) whirlInkCache.clear();
      whirlInkCache.set(color, w);
    }
    return w;
  }
  var withAlpha = (hsl, a) => hsl.replace(")", ` / ${Math.max(0, Math.min(1, a)).toFixed(3)})`);
  function drawWhirl(ctx, pose, color, lx, ly, near, knobs) {
    var _a, _b, _c, _d, _e;
    const strength = (_a = knobs == null ? void 0 : knobs.strength) != null ? _a : 0;
    const k = Math.min(1, pose.whirl * strength);
    if (k <= 0.01) return;
    const sizeK = (_b = knobs == null ? void 0 : knobs.size) != null ? _b : 1, widthK = (_c = knobs == null ? void 0 : knobs.width) != null ? _c : 1, lengthK = (_d = knobs == null ? void 0 : knobs.length) != null ? _d : 1, tiltK = (_e = knobs == null ? void 0 : knobs.tilt) != null ? _e : 1;
    const span = WHIRL_SPAN * lengthK;
    const ink = whirlInk(color);
    const head = -pose.whirlAngle;
    const rx = WHIRL_RX * sizeK;
    const ry = rx * WHIRL_RATIO * tiltK * (near ? 1.14 : 0.86);
    const lightA = Math.atan2(ly, lx) - WHIRL_TILT;
    ctx.save();
    ctx.rotate(WHIRL_TILT);
    ctx.translate(0, 5);
    ctx.lineCap = "butt";
    const seg = (a0, a1, width, style, dy) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.ellipse(0, dy, rx, ry, 0, a0, a1, false);
      ctx.stroke();
    };
    if (near) {
      for (let i = 0; i < WHIRL_SEGMENTS; i++) {
        const f = i / WHIRL_SEGMENTS;
        const a1 = head + f * span, a0 = a1 + span / WHIRL_SEGMENTS + 0.012;
        if (Math.sin((a0 + a1) / 2) <= 0) continue;
        const fade = Math.pow(1 - f, 1.3);
        seg(a1, a0, (2 + 8 * fade) * 1.5 * widthK, `rgba(0,0,0,${(0.2 * k * fade).toFixed(3)})`, 3.5);
      }
    }
    for (let i = 0; i < WHIRL_SEGMENTS; i++) {
      const f = i / WHIRL_SEGMENTS;
      const a1 = head + f * span, a0 = a1 + span / WHIRL_SEGMENTS + 0.012;
      const mid = (a0 + a1) / 2;
      if (Math.sin(mid) > 0 !== near) continue;
      const depth = 0.6 + 0.4 * Math.sin(mid);
      const fade = Math.pow(1 - f, 1.3);
      const puff = 1 + 0.18 * Math.sin(f * 9 + 1.2);
      const width = (2 + 8 * fade) * depth * widthK * puff;
      const a = k * (0.3 + 0.7 * fade) * depth;
      const facing = 0.5 + 0.5 * Math.cos(mid - lightA);
      seg(a1, a0, width * 2.6, withAlpha(ink.halo, a * 0.2), 0);
      seg(a1, a0, width * 0.8, withAlpha(ink.dark, a * 0.45), width * 0.32);
      seg(a1, a0, width, withAlpha(ink.base, a * 0.72), 0);
      seg(a1, a0, width * 0.62, withAlpha(ink.light, a * 0.78 * (0.4 + 0.6 * facing)), -width * 0.16);
      seg(a1, a0, width * 0.24, `rgba(255,255,255,${(a * 0.9 * (0.15 + 0.85 * facing * facing)).toFixed(3)})`, -width * 0.3);
    }
    ctx.restore();
  }
  function draw(ctx, box, pose, cfg) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const full = box * OVERSCAN;
    ctx.clearRect(0, 0, full, full);
    const S = box / 100;
    let dpr, base;
    if (cfg.dpr !== void 0) {
      dpr = cfg.dpr;
      base = [dpr, 0, 0, dpr, 0, 0];
    } else if (ctx.getTransform) {
      const t = ctx.getTransform();
      base = [t.a, t.b, t.c, t.d, t.e, t.f];
      dpr = t.a || 1;
    } else {
      dpr = 1;
      base = [1, 0, 0, 1, 0, 0];
    }
    const shadow = (_a = cfg.shadow) != null ? _a : 0.35, highlight = (_b = cfg.highlight) != null ? _b : 1.3;
    const halfDepth = HALF_DEPTH * ((_c = cfg.depth) != null ? _c : 0.65);
    const cap = 1 - (1 - CAP) * ((_d = cfg.rim) != null ? _d : 0.5);
    const spread = (_e = cfg.spread) != null ? _e : 1.55;
    const la = ((_f = cfg.light) != null ? _f : 265) * Math.PI / 180;
    const lx = Math.sin(la), ly = -Math.cos(la);
    const pal = palette(cfg.color, shadow, highlight);
    const cy0 = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
    const cp0 = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const facing = cy0 * cp0;
    const floor = (v) => Math.abs(v) < 0.22 ? v < 0 ? -0.22 : 0.22 : v;
    const cy = floor(cy0), cp = floor(cp0);
    const cr = Math.cos(pose.roll), sr = Math.sin(pose.roll), kx = pose.sx * S, ky = pose.sy * S;
    const lift = 50 * (1 - pose.sy) * S;
    const body = mulAffine(base, [cr * kx, sr * kx, -sr * ky, cr * ky, full / 2 + pose.x * S - sr * lift, full / 2 + RISE * box + pose.y * S + cr * lift]);
    ctx.save();
    ctx.setTransform(body[0], body[1], body[2], body[3], body[4], body[5]);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const mode = cfg.shading;
    const drawSolid = (path, key, halfDepth2) => {
      var _a2;
      let lit = pal.near;
      let capFill = pal.base;
      if (mode === "crisp") {
        if (!pal.grad || pal.grad.lx !== lx || pal.grad.ly !== ly) {
          const g = ctx.createLinearGradient(lx * 56, ly * 56, -lx * 56, -ly * 56);
          g.addColorStop(0, pal.light);
          g.addColorStop(0.45, pal.near);
          g.addColorStop(1, pal.dark);
          const c = ctx.createLinearGradient(lx * 46, ly * 46, -lx * 46, -ly * 46);
          c.addColorStop(0, pal.capTop);
          c.addColorStop(1, pal.capBottom);
          pal.grad = { lx, ly, lit: g, cap: c };
        }
        lit = pal.grad.lit;
        capFill = pal.grad.cap;
      }
      let plasticDone2 = false;
      if (mode === "plastic") {
        plasticDone2 = drawPlasticCap(
          ctx,
          { ...cfg, path, typeKey: key },
          { cy, sy, cp, sp, facing, roll: pose.roll, halfDepth: halfDepth2, cap, lx, ly, dev: box * dpr, ctm: body, still: cfg.still },
          pal,
          null,
          { shadow, highlight, spread, rim: (_a2 = cfg.rim) != null ? _a2 : 0.5 }
        );
      }
      const mode2 = mode === "plastic" && !plasticDone2 ? "smooth" : mode;
      const soft2 = mode2 === "smooth";
      const union = soft2 && typeof Path2D === "function" ? new Path2D() : null;
      const order = facing >= 0 ? 1 : -1;
      const [ca, cb, cc, cd, ce, cf] = body;
      let fill = null;
      let pa = 1, pb = 0, pc = 0, pd = 1, pe = 0, pf = 0;
      for (let j = 0; j < SLICES2 && !plasticDone2; j++) {
        const k = order > 0 ? j : SLICES2 - 1 - j;
        const z = -1 + 2 * k / (SLICES2 - 1);
        const s = profile2(z, cap);
        const near = j / (SLICES2 - 1);
        const m0 = cy * s, m1 = sy * sp * s, m3 = cp * s;
        const e = z * sy * halfDepth2 - 50 * m0, fo = -z * cy * sp * halfDepth2 - 50 * m1 - 50 * m3;
        const det = pa * pd - pb * pc;
        const ia = pd / det, ib = -pb / det, ic = -pc / det, id = pa / det, ie = (pc * pf - pd * pe) / det, jf = (pb * pe - pa * pf) / det;
        ctx.transform(ia * m0 + ic * m1, ib * m0 + id * m1, ic * m3, id * m3, ia * e + ic * fo + ie, ib * e + id * fo + jf);
        pa = m0;
        pb = m1;
        pc = 0;
        pd = m3;
        pe = e;
        pf = fo;
        let style;
        if (soft2) style = pal.smoothMix[j];
        else if (j === SLICES2 - 1) style = capFill;
        else if (near > 0.6) style = lit;
        else style = pal.crispMix[j];
        if (style !== fill) ctx.fillStyle = fill = style;
        ctx.fill(path);
        if (union) union.addPath(path, { a: m0, b: m1, c: 0, d: m3, e, f: fo });
      }
      if (!plasticDone2) ctx.setTransform(ca, cb, cc, cd, ce, cf);
      if (union && mode2 === "smooth") {
        ctx.save();
        ctx.clip(union);
        const sa = Math.min(1, 0.34 * shadow);
        const sg = ctx.createRadialGradient(-lx * 45, -ly * 45, 4 * spread, -lx * 45, -ly * 45, 84 * spread);
        sg.addColorStop(0, `rgba(0,0,0,${sa})`);
        sg.addColorStop(0.5, `rgba(0,0,0,${sa * 0.35})`);
        sg.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = sg;
        ctx.fillRect(-120, -120, 240, 240);
        ctx.globalCompositeOperation = "source-over";
        const ha = Math.min(1, 0.22 * highlight);
        const hg = ctx.createRadialGradient(lx * 37, ly * 37, 0, lx * 37, ly * 37, 62 * spread);
        hg.addColorStop(0, `rgba(255,255,255,${ha})`);
        hg.addColorStop(0.6, `rgba(255,255,255,${ha * 0.23})`);
        hg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = hg;
        ctx.fillRect(-120, -120, 240, 240);
        ctx.restore();
      }
      return plasticDone2;
    };
    drawWhirl(ctx, pose, cfg.color, lx, ly, false, cfg.whirl);
    if (cfg.parts) drawSolid(cfg.parts, `${(_g = cfg.typeKey) != null ? _g : "custom"}:parts`, halfDepth * ((_h = cfg.partsDepth) != null ? _h : 0.4));
    const plasticDone = drawSolid(cfg.path, (_i = cfg.typeKey) != null ? _i : "custom", halfDepth);
    if (facing > -0.2) {
      ctx.save();
      {
        const zf = facing >= 0 ? 1 : -1;
        const sf = profile2(zf, cap);
        const m0 = cy * sf, m1 = sy * sp * sf, m3 = cp * sf;
        const e = zf * sy * halfDepth - 50 * m0;
        const fo = -zf * cy * sp * halfDepth - 50 * m1 - 50 * m3;
        const [ca, cb, cc, cd, ce, cf] = body;
        ctx.setTransform(ca * m0 + cc * m1, cb * m0 + cd * m1, cc * m3, cd * m3, ca * e + cc * fo + ce, cb * e + cd * fo + cf);
        ctx.clip(cfg.path);
        ctx.setTransform(ca, cb, cc, cd, ce, cf);
      }
      ctx.translate(cfg.faceX - 50, cfg.faceY - 50);
      ctx.scale(cfg.faceScale, cfg.faceScale);
      if (plasticDone) ctx.globalAlpha = 0.93;
      drawFace(ctx, pose, cfg);
      ctx.restore();
    }
    drawWhirl(ctx, pose, cfg.color, lx, ly, true, cfg.whirl);
    ctx.restore();
  }
  var FACE_R = 30;
  function onSphere(x, y, yaw, pitch) {
    const lon = Math.asin(Math.max(-1, Math.min(1, x / FACE_R))) + yaw;
    const lat = Math.asin(Math.max(-1, Math.min(1, -y / FACE_R))) + pitch;
    const cl = Math.cos(lat);
    return {
      x: FACE_R * Math.sin(lon) * cl,
      y: -FACE_R * Math.sin(lat),
      sx: Math.cos(lon),
      sy: cl,
      z: Math.cos(lon) * cl
    };
  }
  var EYE_STEPS = 8;
  var eyePaths = /* @__PURE__ */ new Map();
  function eyePath(x0, y0, cy) {
    const qx = Math.round(x0 * 50), qy = Math.round(y0 * 50), qc = Math.round(cy * 50);
    const key = qx + 2e3 * qy + 4e6 * qc;
    let p = eyePaths.get(key);
    if (!p) {
      const ax = qx / 50, ay = qy / 50, ac = qc / 50;
      let d = `M${-ax} ${ay}`;
      for (let i = 1; i <= EYE_STEPS; i++) {
        const t = i / EYE_STEPS, mt = 1 - t;
        d += ` L${(mt * mt * -ax + t * t * ax).toFixed(3)} ${((mt * mt + t * t) * ay + 2 * mt * t * ac).toFixed(3)}`;
      }
      p = new Path2D(d);
      if (eyePaths.size > 256) eyePaths.clear();
      eyePaths.set(key, p);
    }
    return p;
  }
  var MOUTH_SIN = Math.sin(0.684);
  var MOUTH_COS = Math.cos(0.684);
  var mouthPaths = /* @__PURE__ */ new Map();
  function mouthPath(m) {
    const q = (v) => Math.round(v * 50) / 50;
    const hw = q(m.hw), t0 = q(m.t0), a = q(m.a), yt = q(m.yt), ab = q(m.ab), yb = q(m.yb);
    const key = `${hw},${t0},${a},${yt},${ab},${yb}`;
    let p = mouthPaths.get(key);
    if (p) return p;
    const f = (v) => v.toFixed(3);
    const nx = t0 * MOUTH_SIN, ny = t0 * MOUTH_COS;
    const ltx = -hw + nx, lty = -ny, rtx = hw - nx, rty = -ny;
    const lbx = -hw - nx, lby = ny, rbx = hw + nx, rby = ny;
    const cx = 4 / 3 * t0 * MOUTH_COS, cy = 4 / 3 * t0 * MOUTH_SIN;
    const d = `M${f(ltx)} ${f(lty)}C${f(-hw + a * hw)} ${f(yt - t0)} ${f(hw - a * hw)} ${f(yt - t0)} ${f(rtx)} ${f(rty)}C${f(rtx + cx)} ${f(rty - cy)} ${f(rbx + cx)} ${f(rby - cy)} ${f(rbx)} ${f(rby)}C${f(hw - ab * hw)} ${f(yb + t0)} ${f(-hw + ab * hw)} ${f(yb + t0)} ${f(lbx)} ${f(lby)}C${f(lbx - cx)} ${f(lby - cy)} ${f(ltx - cx)} ${f(lty - cy)} ${f(ltx)} ${f(lty)}Z`;
    p = new Path2D(d);
    if (mouthPaths.size > 256) mouthPaths.clear();
    mouthPaths.set(key, p);
    return p;
  }
  function drawFace(ctx, pose, cfg) {
    const [wd, ww, ws] = pose.w;
    const ink = cfg.ink;
    const ey = EYE_Y[cfg.face];
    const half = EYE_GAP / 2;
    const lx = pose.lookX, ly = pose.lookY;
    const { yaw, pitch } = pose;
    const at = (x, y, fn, alpha = 1) => {
      const q = onSphere(x, y, yaw, pitch);
      if (q.z <= 0.02 || alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = alpha * Math.min(1, q.z * 5);
      ctx.translate(q.x, q.y);
      ctx.scale(Math.max(0.02, q.sx), Math.max(0.02, q.sy));
      fn();
      ctx.restore();
    };
    const past = (v, d) => Math.abs(v) <= d ? 0 : Math.sign(v) * (Math.abs(v) - d) / (1 - d);
    const clamp1 = (v) => Math.max(-1, Math.min(1, v));
    const up = past(clamp1(-pose.pitch / 0.26 - pose.lookY / 7), 0.34);
    const side = Math.abs(past(clamp1(pose.lookX / 4.5), 0.4));
    const tall = Math.max(0.3, 1 + 0.55 * up - 0.1 * side);
    const wide = 1 - 0.05 * up + 0.12 * side;
    const open = wd + ww * (1 - pose.laugh);
    const laugh = ww * pose.laugh;
    const lift = Math.max(0, -pose.y) / 26;
    const sag = 0.5 + 0.5 * pose.breath;
    for (const side2 of [-1, 1]) {
      const lid = side2 < 0 ? pose.blinkL : pose.blinkR;
      const e = Math.max(0, Math.min(1, pose.eyeOpen * (1 - lid)));
      const kOpen = open * e, kShut = open * (1 - e), kLaugh = laugh, kSleep = ws;
      const x0 = kOpen * 0.01 + kShut * 5.4 + kLaugh * 6.2 + kSleep * 6;
      const y0 = kOpen * 1.1 * tall + kShut * 0.6 + kLaugh * (2.2 - lift * 1.5) + kSleep * (-1.4 + sag);
      const cy = kOpen * -3.3 * tall + kShut * 0.6 + kLaugh * (-11.4 - 4 * lift) + kSleep * (5.4 + 2 * sag);
      const w = kOpen * EYE_RX * 2 * wide + kShut * 2.8 + kLaugh * 4.4 + kSleep * 4;
      const dx = lx * (kOpen + 0.5 * (kShut + kLaugh)), dy = ly * (kOpen + 0.5 * kShut);
      at(side2 * half + dx, ey + dy, () => {
        ctx.strokeStyle = ink;
        ctx.lineWidth = w;
        ctx.stroke(eyePath(x0, y0, cy));
      });
    }
    if (cfg.face === "mouth") {
      const mx = lx * 0.35;
      const kd = (0.6 + 0.4 * wd) * (1 + 0.06 * pose.breath);
      const kw = (0.6 + 0.4 * ww) * (1 + 0.25 * Math.max(0, -pose.y) / 26);
      const r = 2.7 * ws * (1 + 0.25 * pose.breath);
      const b = (d, w, s) => wd * d + ww * w + ws * s;
      const m = {
        hw: b(6.5 * kd, 9.5 * kw, r),
        t0: b(1.9, 0, 0),
        a: b(2 / 3, 2 / 3, 0),
        yt: b(3.53 * kd, 1.6 * kw, -4 * r / 3),
        ab: b(2 / 3, 0, 0),
        yb: b(3.53 * kd, 17.3 * kw, 4 * r / 3)
      };
      at(mx, b(12.5, 11.6, 15.5), () => {
        ctx.fillStyle = ink;
        ctx.fill(mouthPath(m));
      });
    }
  }

  // src/ticker.ts
  var pointer = { x: NaN, y: NaN };
  var subs = /* @__PURE__ */ new Set();
  var raf = 0;
  var last = 0;
  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1e3) : 0;
    last = now;
    subs.forEach((fn) => fn(dt));
    if (subs.size) raf = requestAnimationFrame(frame);
  }
  function start() {
    if (raf || typeof document === "undefined" || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  var wired = false;
  function wire() {
    if (wired || typeof document === "undefined") return;
    wired = true;
    document.addEventListener("pointermove", (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
    }, { passive: true });
    document.addEventListener("pointerleave", () => {
      pointer.x = NaN;
      pointer.y = NaN;
    });
    window.addEventListener("blur", () => {
      pointer.x = NaN;
      pointer.y = NaN;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (subs.size) start();
    });
  }
  function subscribe(fn) {
    wire();
    subs.add(fn);
    start();
    return () => {
      subs.delete(fn);
      if (!subs.size && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
  }
  return __toCommonJS(freeagents_entry_exports);
})();
