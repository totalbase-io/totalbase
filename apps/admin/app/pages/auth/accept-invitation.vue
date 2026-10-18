<script setup lang="ts">
// Opened from an invitation email (auth.links.invitation's default).
definePageMeta({ layout: false })
</script>

<template>
  <AuthTokenPasswordForm
    endpoint="/api/auth/invitations/accept"
    :title="$t('auth.acceptInvitation.title')"
    :description="$t('auth.acceptInvitation.description')"
    :submit-label="$t('auth.acceptInvitation.submitLabel')"
    :success-title="$t('auth.acceptInvitation.successTitle')"
    :success-description="$t('auth.acceptInvitation.successDescription')"
  />
</template>
