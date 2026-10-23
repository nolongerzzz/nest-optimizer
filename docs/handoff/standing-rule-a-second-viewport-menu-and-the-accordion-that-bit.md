## Standing rule - a second viewport menu, and the accordion that bit
Found at the Pottery Wheel merge, and it will bite the next person who adds a
viewport `<details class="vp-menu">`.

`.vp-menu` is an **exclusive accordion**: the `toggle` handler in
`app-join.js` closes every other menu when one opens. Correct for users - the
menu bodies overlap - and invisible for as long as **Finish was the only
`.vp-menu` on the page**. The Wheel menu is the second one, and five suites
broke the moment it landed:

    nso_paint_arming_test   nso_pose_after_bake_test   nso_center_lock_test
    nso_flip_port_test      nso_wire_fuse_test

All five did `querySelectorAll('details').forEach(d => d.open = true)` and
then clicked a button inside Finish. With one menu that worked; with two, the
last toggle to fire closes Finish and the button is `not visible`.

**The subtlety that matters, because the obvious fix does not work.** `toggle`
on a `<details>` fires **asynchronously**. So re-opening Finish in the same
evaluate is a no-op - it is still `open` at that instant - and the queued
accordion handlers then close it anyway. The fix has to let the toggles settle
first:

```js
document.querySelectorAll('details').forEach(d => { d.open = true; });
await new Promise(r => setTimeout(r, 0));          // let the accordion settle
document.querySelectorAll('.vp-menu').forEach(m => {
  m.open = m.classList.contains('vp-finish-menu'); // then say which one
});
await new Promise(r => setTimeout(r, 0));
```

All five now do exactly that, so a **third** menu will not break them again.
A new drive check should open the menu it needs by name rather than opening
everything - the pattern `nso_wire_smooth_test.js`, `nso_wire_extend_test.js`
and `nso_wire_wheel_test.js` already use (walk up from the button to its
`DETAILS` and open that chain) is accordion-proof and needs no settle.
