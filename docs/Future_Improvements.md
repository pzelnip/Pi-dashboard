# Future Improvements

## Move the Code

Top level dir is a mix of code as it's run on the Pi, docs, readme's, the
Claude.md file, etc.

Create a `src/` directory and move all code into there.  Be sure to update all
docs around this change (ex: deployment docs).

Since tests will move, that'll likely imply changes to the Github workflows

In this change include details on what needs to change re the scripts that run
the server on the Pi since the code will have to run from a src/ subdirectory of
the clone on the Pi.
