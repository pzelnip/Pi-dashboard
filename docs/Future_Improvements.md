# Future Improvements

## NHL Playoff display round

Open in https://github.com/pzelnip/Pi-dashboard/pull/12

For each NHL game in the NHL panel, display which "round" a game is if it's a
playoff game.  Ex: currently CAR & PHI is round 2, but MTL & TBL is round 1.

## NHL game interactivity

Open in https://github.com/pzelnip/Pi-dashboard/pull/13

Clicking an NHL game should bring up a panel (not unlike the debug panel) that
contains all information obtained from the feed.  For example, things like the
arena it's being played at, a clickable link to more details elsewhere (ex the
seriesUrl), if it's being broadcast and where, odds, full team name (ex: "Tampa
Bay Lightning" rather than "Lightning" or "TBL").

Don't consider this an exhuastive list, be creative on what info can be included
on the display.

## Python version link

On the debug panel, make the python version a clickable link that goes to:
https://docs.python.org/release/<VERSION/ in a new tab

## User Agent Info

For the User Agent string, both display the actual UA string, but also what
browser, OS, etc, it is.  If this is not possible with out additional
dependencies (ie if there's no standard library item to give this info)
then instead link to a site that gives this info.

## Link Weather pane to Weather Site

Clicking the weather should take me to a site that gives more detailed
weather info in a new tab.
