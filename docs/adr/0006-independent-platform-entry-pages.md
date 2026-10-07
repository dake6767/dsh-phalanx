# 0006: Independent platform entry pages

Status: accepted

Login, first-administrator initialization and instance recovery must remain
usable when management assets fail to load or DSH cannot start. The platform
renders these pages as lightweight HTML with only the scripts needed for their
forms and appearance. They do not load the management React application.

Platform pages and the management application share appearance tokens and the
System/Light/Dark preference. The initial page applies the preference before
paint. System mode follows the operating system. DSH's platform account menu
follows native DSH appearance through its official sidebar footer seam.

Authentication, HTTP status codes, initialization expiration/closure and member
recovery authority remain server responsibilities. Error responses render a
complete entry page. Initialization credentials stay in the fragment and the
form submission; errors and appearance state do not retain them.

The platform service is still required. This separation does not provide an
offline login or a replacement DSH interface. Maintaining a small shared page
renderer and appearance definition is preferable to making emergency recovery
depend on the full management bundle.
