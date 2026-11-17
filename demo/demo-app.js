// DeepScope Demo App Bundle (Simulated production chunk)

// 1. GraphQL Operations (Feature 6)
const GET_SECRET_USER = `
  query GetSecretUser($id: ID!, $includeAdminData: Boolean) {
    user(id: $id) {
      id
      username
      email
      role
      permissions
    }
  }
`;

const MUTATION_UPDATE = `
  mutation UpdateUserRole($userId: ID!, $newRole: String!) {
    updateUserRole(id: $userId, role: $newRole) {
      success
      message
    }
  }
`;

// 2. API Call with Parameters & Payload Schema (Feature 4)
async function sendPayment(user, cardToken, amount) {
  return fetch('/api/v1/billing/charge?currency=USD&immediate=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: user,
      cardToken: cardToken,
      amount: amount,
      bypassPin: false,
      promoCode: null
    })
  });
}

function searchEmployees(dept, limit, offset) {
  return fetch('/api/internal/employees?dept=finance&limit=25&offset=0');
}

console.log('DeepScope demo-app.js loaded.');

//# sourceMappingURL=demo-app.js.map
