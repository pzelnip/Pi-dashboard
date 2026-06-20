.PHONY: test run-local

test:
	cd src && python3 -m unittest discover -v

run-local:
	python3 src/server.py
