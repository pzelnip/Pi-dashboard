.PHONY: test run-local pi-shot mac-shot

test:
	cd src && python3 -m unittest discover -v

run-local:
	python3 src/server.py

# Screenshots for comparing the Pi's rendering with this machine's.
# See docs/pi-screenshots.md.
pi-shot:
	./pi-screenshot.sh live

mac-shot:
	./pi-screenshot.sh mac
