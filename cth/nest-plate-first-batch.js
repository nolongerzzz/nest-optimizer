/** Live batch 1. Hull aims accept catalog hull or exported CTH_fixture. */
const HULL = ['box_hull', 'CTH_fixture'];

export const NEST_PLATE_FIRST_BATCH = [
  {
    id: 'hull-face',
    title: 'Hull face — opposite wall',
    instruction: 'The yellow wall opposite the opening, the one with no hole in it. Click the flat of it, away from any edge.',
    accept: { objectId: HULL },
  },
  {
    id: 'slot-mouth',
    title: 'Slot mouth — pocket floor',
    instruction: 'The red floor inside the opening. Click straight down the mouth so the ray reaches the pocket, not its rim.',
    accept: { objectId: 'pocket' },
  },
  {
    id: 'occlusion',
    title: 'Occlusion — near lip in front of the pocket',
    instruction: 'The yellow rim of that same opening, the near lip. The pocket sits directly behind it, so the lip must win.',
    accept: { objectId: HULL },
  },
  {
    id: 'after-tip',
    title: 'After tip — same wall as aim 1',
    instruction: 'Tip the part once, then click the SAME opposite wall as aim 1 from the new angle.',
    accept: { objectId: HULL },
  },
];

export default NEST_PLATE_FIRST_BATCH;
