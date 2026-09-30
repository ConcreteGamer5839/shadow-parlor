/**
 * Shadow Parlor entry point.
 */
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { ParlorSystem } from './parlor-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(ParlorSystem);
  (window as any).__world = world;
});
