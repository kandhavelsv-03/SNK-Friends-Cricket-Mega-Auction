# Auction Improvements Applied

This update includes:
- Manual bid increment buttons: ₹25 lakh, ₹50 lakh, ₹1 crore, ₹2 crore, ₹5 crore.
- More prominent gold current-bid display.
- Category minimums are enforced only when a team reaches 20 players; category maximums remain enforced throughout.
- RTM now uses the same central confirmation modal and displays an RTM-by-team result animation.
- Faster SOLD/UNSOLD/RTM result banner dismissal.
- Retention page now requires selecting a previous team first, then lists only that team's eligible players.
- Releasing a retained player refunds the retention amount and restores the matching RTM entitlement.
- New Sold Players page with confirmation-based sale cancellation / bring-back action.
- Cancelling a sold purchase refunds the buying team's purse; RTM card is restored when the reversed sale was an RTM.
- Error/success messages are displayed in a larger central dialog rather than a small corner toast.

## Validation performed
- `node --check server.js` passed.
- `node --check public/app.js` passed.

## Important limitation
This package is based on the uploaded MySQL version of the project. It is NOT the MongoDB Atlas migration. Database/API integration and full browser auction testing still need to be performed against a configured MySQL database before production use.
