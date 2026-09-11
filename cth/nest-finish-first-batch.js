/** Finish ray batch. Same fixture. Diagnoses what Soften/Paint would hit. */
const HULL = ['box_hull', 'CTH_fixture'];

export const NEST_FINISH_FIRST_BATCH = [
  {
    id: 'paint-hull',
    title: 'Paint — outer hull face',
    instruction: 'Arm pick, then click a yellow outer wall. This is the face Paint should exclude.',
    accept: { objectId: HULL, region: 'hull' },
  },
  {
    id: 'paint-pocket',
    title: 'Paint — pocket floor',
    instruction: 'Look down the mouth. Click the pocket floor, not the rim.',
    accept: { objectId: HULL, region: 'pocket' },
  },
  {
    id: 'soften-mouth',
    title: 'Soften — near mouth',
    instruction: 'Click just outside the opening on the hull lip. Soften currently hits this instead of the pocket.',
    accept: { objectId: HULL, region: 'hull' },
  },
  {
    id: 'soften-pocket',
    title: 'Soften — pocket floor again',
    instruction: 'Same mouth shot as aim 2. Confirms the pocket is still reachable after a lip click.',
    accept: { objectId: HULL, region: 'pocket' },
  },
];

export default NEST_FINISH_FIRST_BATCH;
