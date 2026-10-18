<script setup lang="ts">
// Opened from a password reset email (auth.links.password_reset's default).
definePageMeta({ layout: false })
</script>

<template>
  <AuthTokenPasswordForm
    endpoint="/api/auth/password/reset"
    :title="$t('auth.resetPassword.title')"
    :description="$t('auth.resetPassword.description')"
    :submit-label="$t('auth.resetPassword.submitLabel')"
    :success-title="$t('auth.resetPassword.successTitle')"
    :success-description="$t('auth.resetPassword.successDescription')"
  />
</template>
