/* The Join card, opened the way a person opens it, for the checks.

   There is no Start Join button: the Join column button is the switch, and
   opening it starts the session and shows the Join card (app-join.js,
   joinWireCard). A check that used to press #btn-join-start presses the column
   button instead.

     openJoin(page)   a fresh Join session from the column button. If the card
                      is already open it is shut first (which is Cancel Join),
                      so the press is always a start, as Start Join was - a
                      second call restarts instead of toggling the card off.
                      Resolves once the session is live.

   The column button is a <summary>, which the harness leaves alone (a click on
   a summary toggles its menu exactly as written; nso_app_harness.js). */
async function openJoin(page) {
  await page.evaluate(() => { const d = document.getElementById('menu-joins'); if (d && d.open) d.open = false; });
  await page.click('#menu-joins > summary');
  await page.waitForFunction(() => state.joinSession === true, null, { timeout: 5000 });
}

module.exports = { openJoin };
