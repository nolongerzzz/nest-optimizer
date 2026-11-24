/* The Join session, started the way a person starts it, for the checks.

   There is no Start Join button: the Assemble column button is the switch, and
   opening it starts the session and shows the Assemble card, whose Join by
   slots, Seat and Align sections work in it (app-join.js, joinWireCard). A
   check that used to press #btn-join-start presses the column button instead;
   the harness opens the section a control sits in before it acts on it.

     openJoin(page)   a fresh Join session from the column button. If the card
                      is already open it is shut first (which is Cancel Join),
                      so the press is always a start, as Start Join was - a
                      second call restarts instead of toggling the card off.
                      Resolves once the session is live.

   The column button is a <summary>, which the harness leaves alone (a click on
   a summary toggles its menu exactly as written; nso_app_harness.js). */
async function openJoin(page) {
  await page.evaluate(() => { const d = document.getElementById('menu-assemble'); if (d && d.open) d.open = false; });
  await page.click('#menu-assemble > summary');
  await page.waitForFunction(() => state.joinSession === true, null, { timeout: 5000 });
}

module.exports = { openJoin };
