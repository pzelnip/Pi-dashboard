# Future Improvements

## Reorganize the docs

Docs (with the exception of README.md) should live in a `docs/` directory.
Include moving the screenshots into that docs directory and have readme
link to that location (ie `docs/screenshots/somescreenshot.jpg`)

## Move the Code

Top level dir is a mix of code as it's run on the Pi, docs, readme's, the
Claude.md file, etc.

Create a `src/` directory and move all code into there.  Be sure to update
all docs around this change (ex: deployment docs).

Since tests will move, that'll likely imply changes to the Github workflows

In this change include details on what needs to change re the scripts that
run the server on the Pi.
