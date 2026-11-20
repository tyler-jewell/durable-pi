# Check required local runtime state. Prints status lines, never file contents.
[no-cd]
doctor:
    DPI_DOCTOR_OVERLAY=llama/hosts.yaml node scripts/doctor.mts
