Open a PDF from a thread and read it in place. The plugin shows the document in the panel where bb normally shows a file preview.

## What you get

- Page navigation, zoom, and text search from your browser PDF viewer.
- A loading indicator while bb fetches the file and while the viewer renders it.
- A clear error message and a Retry button when the file does not load.

## How it works

The plugin adds a `sidePanel.fileViewer` entry for the `pdf` extension. It works wherever the side panel opens a file: a thread workspace, the host machine, or thread storage. bb fetches the file from the address the side panel gives it and confirms that the response is a PDF. It then hands the file to the browser viewer inside a frame.

No account, external service, or separate install is required. The browser or app shell must include a PDF viewer. The bb desktop app includes one.
