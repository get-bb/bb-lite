# Project checkout

The `project-checkout` environment kind: threads run in the project's own checkout (or a given `path`), shared by every thread there. Inputs may switch to an existing branch or create a new one, refused while another thread uses the checkout.
